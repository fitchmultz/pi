import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Message,
	Model,
	OpenAIResponsesCompat,
	ResponseControl,
	ToolReference,
	ToolResultMessage,
	TranscriptContext,
} from "../types.ts";
import { shortHash } from "../utils/hash.ts";
import { toolKey, toToolReference } from "../utils/tool-identity.ts";
import { normalizeContext } from "../utils/transcript.ts";
import { lazyStream } from "./lazy.ts";

// Models, provider factories, and direct adapters can wrap the same request.
const namespaceMapping = Symbol("namespaceMapping");

/** Adapt wire identities without changing the registry, hooks, or persisted transcript. */
export function withToolNamespaces(
	model: Model<Api>,
	context: TranscriptContext,
	run: (
		context: TranscriptContext,
		mapControl: (control: ResponseControl | undefined) => ResponseControl | undefined,
	) => AssistantMessageEventStream,
	signal?: AbortSignal,
): AssistantMessageEventStream {
	if (namespaceMapping in context) return run(context, (control) => control);
	const native = ["openai-responses", "openai-codex-responses", "azure-openai-responses"].includes(model.api);
	const compat = native ? (model.compat as OpenAIResponsesCompat | undefined) : undefined;
	const references: ToolReference[] = [];
	const loadedBare = new Set<string>();
	const declaredNamespaces = new Set<string>();
	let hasSearchState = false;
	for (const [index, message] of context.messages.entries()) {
		const declarations = message.role === "system" || message.role === "toolResult" ? (message.toolsAdded ?? []) : [];
		references.push(...declarations);
		for (const tool of declarations) {
			if (tool.namespace !== undefined) declaredNamespaces.add(tool.namespace);
			else if (
				compat?.supportsToolSearch &&
				(message.role === "toolResult" || (index > 0 && !compat.supportsAdditionalTools))
			)
				loadedBare.add(toolKey(tool));
		}
		if (message.role === "system") references.push(...(message.toolsRemoved ?? []));
		if (message.role === "assistant")
			for (const block of message.content ?? []) if (block.type === "toolCall") references.push(block);
		if (message.role === "toolResult") {
			references.push({ name: message.toolName, namespace: message.namespace });
			hasSearchState ||= message.toolsAdded !== undefined;
		}
	}
	if (
		native ? !compat?.supportsToolSearch : !hasSearchState && !references.some((tool) => tool.namespace !== undefined)
	)
		return run(context, (control) => control);
	return lazyStream(
		model,
		async () => {
			const encoded = new Map<string, ToolReference>();
			const decoded = new Map<string, ToolReference>();
			const bareNames = new Set(references.filter((tool) => tool.namespace === undefined).map((tool) => tool.name));
			const register = (references: readonly ToolReference[]): void => {
				for (const reference of references) {
					const key = toolKey(reference);
					if (native ? !loadedBare.has(key) : reference.namespace === undefined) continue;
					// Search-loaded bare functions otherwise acquire an implicit provider namespace.
					// Use an explicit one so an unknown namespace can never select a bare tool.
					const wire: ToolReference = native
						? { name: reference.name, namespace: `pi_loaded_${shortHash(key)}` }
						: { name: `pi_ns_${shortHash(key)}` };
					const existing = decoded.get(toolKey(wire));
					if (
						(native ? declaredNamespaces.has(wire.namespace!) : bareNames.has(wire.name)) ||
						(existing && toolKey(existing) !== key)
					) {
						throw new Error(`Ambiguous namespaced tool alias ${toolKey(wire)}`);
					}
					encoded.set(key, wire);
					decoded.set(toolKey(wire), toToolReference(reference));
				}
			};
			register(references);
			const encode = <T extends ToolReference>(tool: T): T => {
				const wire = encoded.get(toolKey(tool));
				return wire === undefined ? tool : { ...tool, name: wire.name, namespace: wire.namespace };
			};
			const mapResult = (message: ToolResultMessage): ToolResultMessage => {
				const reference = encode({ name: message.toolName, namespace: message.namespace });
				return {
					...message,
					toolName: reference.name,
					namespace: reference.namespace,
					toolCallKind: native ? message.toolCallKind : undefined,
					toolsAdded: native ? message.toolsAdded?.map(encode) : undefined,
				};
			};
			const messages = context.messages.flatMap((message): Message[] => {
				if (message.role === "system")
					return [
						{
							...message,
							toolsAdded: message.toolsAdded?.map(encode),
							toolsRemoved: message.toolsRemoved?.map(encode),
						},
					];
				if (message.role === "assistant")
					return [
						{
							...message,
							content: (message.content ?? []).map((block) =>
								block.type === "toolCall" ? { ...encode(block), kind: native ? block.kind : undefined } : block,
							),
						},
					];
				if (message.role !== "toolResult") return [message];
				const result = mapResult(message);
				return !native && message.toolsAdded?.length
					? [
							result,
							{
								role: "system",
								content: "",
								toolsAdded: message.toolsAdded.map(encode),
								timestamp: message.timestamp,
							},
						]
					: [result];
			});
			const decode = <T extends ToolReference>(tool: T): T => {
				const reference = decoded.get(toolKey(tool));
				return reference ? { ...tool, name: reference.name, namespace: reference.namespace } : tool;
			};
			const restore = (message: AssistantMessage): AssistantMessage => ({
				...message,
				content: message.content.map((block) => (block.type === "toolCall" ? decode(block) : block)),
			});
			const mapped = normalizeContext({ messages });
			Object.defineProperty(mapped, namespaceMapping, { value: true });
			const source = run(
				mapped,
				(control) =>
					control && {
						get waitingForSuccessor() {
							return control.waitingForSuccessor;
						},
						get retired() {
							return control.retired;
						},
						deliveredToolCallIds: control.deliveredToolCallIds,
						steer: (message) => control.steer(message),
						retire: () => control.retire(),
						submitToolResults: (results) => {
							const declarations = results.flatMap((result) => result.toolsAdded ?? []);
							for (const tool of declarations) {
								if (tool.namespace === undefined) loadedBare.add(toolKey(tool));
								else {
									if (decoded.has(toolKey(tool)))
										throw new Error(`Ambiguous namespaced tool alias ${toolKey(tool)}`);
									declaredNamespaces.add(tool.namespace);
								}
							}
							register(declarations);
							control.submitToolResults(results.map(mapResult));
						},
					},
			);
			return (async function* (): AsyncGenerator<AssistantMessageEvent> {
				for await (const event of source) {
					if (event.type === "done" || event.type === "response_end")
						yield { ...event, message: restore(event.message) };
					else if (event.type === "start" && event.continuationInput !== undefined)
						yield {
							...event,
							partial: restore(event.partial),
							continuationInput: event.continuationInput.map((message) => {
								if (message.role !== "toolResult") return message;
								const reference = decode({ name: message.toolName, namespace: message.namespace });
								return {
									...message,
									toolName: reference.name,
									namespace: reference.namespace,
									toolsAdded: message.toolsAdded?.map(decode),
								};
							}),
						};
					else if (event.type === "steering") yield event;
					else if (event.type === "error") yield { ...event, error: restore(event.error) };
					else if (event.type === "toolcall_end")
						yield { ...event, toolCall: decode(event.toolCall), partial: restore(event.partial) };
					else yield { ...event, partial: restore(event.partial) };
				}
			})();
		},
		signal,
	);
}
