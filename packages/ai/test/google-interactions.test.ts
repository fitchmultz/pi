import type { Interactions } from "@google/genai";
import { afterEach, describe, expect, it } from "vitest";
import { type GoogleInteractionsOptions, stream, streamSimple } from "../src/api/google-interactions.ts";
import { getEffectiveCacheRetention } from "../src/cache-warming.ts";
import { createModels, getMidConvoToolSupport } from "../src/models.ts";
import { googleProvider } from "../src/providers/google.ts";
import { cleanupSessionResources } from "../src/session-resources.ts";
import type {
	AssistantMessage,
	Context,
	FetchFunction,
	Model,
	Tool,
	ToolResultMessage,
	UserMessage,
} from "../src/types.ts";
import { isRecoverableLength } from "../src/utils/overflow.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model = {
	provider: "google",
	id: "gemini-4-neon",
	name: "Gemini 4 Neon",
	api: "google-interactions",
	baseUrl: "https://generativelanguage.googleapis.com/v1beta",
	input: ["text", "image"],
	reasoning: true,
	thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh" },
	contextWindow: 1048576,
	maxTokens: 65536,
	cost: { input: 3, output: 15, cacheRead: 0.15, cacheWrite: 0 },
} satisfies Model<"google-interactions">;
const tool: Tool = {
	name: "lookup",
	description: "Look up a status",
	parameters: {
		type: "object",
		properties: { region: { type: "string", const: "west" }, verbose: { type: "boolean" } },
		required: ["region"],
	},
};
const strict = { ...tool, constrainedSampling: { type: "json_schema", strict: "prefer" } } satisfies Tool;
const imageData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const prompt = (content: UserMessage["content"]): UserMessage => ({ role: "user", content, timestamp: 1 });
const initial = prompt("initial prompt");
const next = prompt("follow-up");
const steer = { role: "system", content: "", sections: { format: "Reply in one word" }, timestamp: 2 } as const;
const toolResult = (id = "call-1"): ToolResultMessage => ({
	role: "toolResult",
	toolCallId: id,
	toolName: tool.name,
	isError: true,
	timestamp: 2,
	content: [
		{ type: "text", text: "Lookup failed" },
		{ type: "image", data: imageData, mimeType: "image/png" },
	],
});

type Lifecycle = Interactions.InteractionCompletedEvent["interaction"];
type CreateBody = Omit<Interactions.InteractionCreateParams.CreateModelInteractionParams, "input" | "tools"> & {
	input?: Interactions.Step[];
	tools?: Interactions.Function[];
};
const completed = (
	id: string,
	status = "completed",
	more?: Partial<Lifecycle>,
): Interactions.InteractionCompletedEvent => ({
	event_type: "interaction.completed",
	interaction: { id, status, ...more },
});
const begin = (index: number, step: Interactions.Step): Interactions.StepStart => ({
	event_type: "step.start",
	index,
	step,
});
const delta = (index: number, update: Interactions.StepDelta["delta"]): Interactions.StepDelta => ({
	event_type: "step.delta",
	index,
	delta: update,
});
const end = (index: number): Interactions.StepStop => ({ event_type: "step.stop", index });

function sse(...events: Interactions.InteractionSSEEvent[]): Response {
	return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

function answer(id: string, text = "answer"): Response {
	return sse(begin(0, { type: "model_output" }), delta(0, { type: "text", text }), end(0), completed(id));
}

function toolAnswer(id: string): Response {
	return sse(
		begin(0, { type: "function_call", name: tool.name, id: "call-1", arguments: { region: "west" } }),
		end(0),
		completed(id, "requires_action"),
	);
}

function rejection(status: number, message: string): Response {
	return Response.json(
		{ error: { code: status, message, status: status === 404 ? "NOT_FOUND" : "INVALID_ARGUMENT" } },
		{ status },
	);
}

function stub(...responses: Response[]) {
	const bodies: CreateBody[] = [];
	const requests: Request[] = [];
	const fetch: FetchFunction = async (input, init) => {
		const request = new Request(input, init);
		requests.push(request);
		if (request.method === "POST" && !request.url.endsWith("/cancel")) bodies.push(await request.json());
		const response = responses.shift();
		if (!response) throw new Error(`Unexpected ${request.method} ${request.url}`);
		return response;
	};
	return { bodies, requests, fetch };
}

function send(
	fetch: FetchFunction,
	messages: Context["messages"],
	options?: GoogleInteractionsOptions,
	tools = [tool],
) {
	return stream(model, normalizeContext({ systemPrompt: "initial system instruction", tools, messages }), {
		apiKey: "offline-key",
		fetch,
		sessionId: "session",
		maxRetries: 0,
		...options,
	});
}

afterEach(() => cleanupSessionResources());

describe("Google Interactions request projection", () => {
	it("keeps leading instructions, images, failed tool results, and inline updates in their wire positions", async () => {
		const { fetch, bodies } = stub(toolAnswer("first"), answer("second"));
		const user = prompt([
			{ type: "text", text: "Look up this image" },
			{ type: "image", mimeType: "image/png", data: imageData },
		]);
		const first = await send(fetch, [user], { store: false }).result();
		const result = await send(fetch, [user, first, steer, toolResult(), next], { store: false }).result();
		expect(result.stopReason).toBe("stop");
		const image = { type: "image", mime_type: "image/png", data: imageData };
		expect(bodies[1]).toMatchObject({
			system_instruction: "initial system instruction",
			store: false,
			tools: [
				{
					type: "function",
					name: "lookup",
					parameters: { properties: { region: { type: "string", enum: ["west"] } } },
				},
			],
			input: [
				{ type: "user_input", content: [{ type: "text", text: "Look up this image" }, image] },
				{ type: "function_call", id: "call-1", name: "lookup", arguments: { region: "west" } },
				{
					type: "function_result",
					call_id: "call-1",
					is_error: true,
					result: [{ type: "text", text: "Lookup failed" }, image],
				},
				{ type: "user_input", content: [{ type: "text", text: expect.stringContaining("<system_update>") }] },
				{ type: "user_input", content: [{ type: "text", text: "follow-up" }] },
			],
		});
		expect(bodies[1].previous_interaction_id).toBeUndefined();
		expect(bodies[1].tools?.[0]?.parameters).not.toHaveProperty("properties.region.const");
	});

	it.each([
		{ api: "google-generative-ai", provider: "google", id: model.id, replay: true },
		{ api: "google-vertex", provider: "google", id: model.id, replay: true },
		{ api: "google-interactions", provider: "google", id: model.id, replay: true },
		{ api: "google-generative-ai", provider: "google", id: "gemini-4-carbon", replay: false },
		{ api: "google-vertex", provider: "google-vertex", id: model.id, replay: false },
	] as const)("replays signatures from $provider/$id using $api: $replay", async ({ api, provider, id, replay }) => {
		const { fetch, bodies } = stub(toolAnswer("old"), answer("resumed"));
		const original = await send(fetch, [initial]).result();
		const prior: AssistantMessage = {
			...original,
			api,
			provider,
			model: id,
			googleInteractionsReplay: undefined,
			content: [
				{ type: "thinking", thinking: "Look up the status.", thinkingSignature: "dGhvdWdodA==" },
				{
					type: "toolCall",
					id: "call-1",
					name: "lookup",
					arguments: { region: "west" },
					thoughtSignature: "Y2FsbA==",
				},
				{ type: "text", text: "" },
			],
		};
		const result = await send(fetch, [initial, prior, toolResult()]).result();
		expect(result.stopReason).toBe("stop");
		const call = { type: "function_call", id: "call-1", name: "lookup", arguments: { region: "west" } };
		expect(bodies[1].input?.slice(1, -1)).toEqual(
			replay
				? [
						{
							type: "thought",
							signature: "dGhvdWdodA==",
							summary: [{ type: "text", text: "Look up the status." }],
						},
						{ type: "thought", signature: "Y2FsbA==" },
						call,
					]
				: [{ ...call, signature: "skip_thought_signature_validator" }],
		);
	});

	it("replays unsigned calls from another API with matching result IDs", async () => {
		const { fetch, bodies } = stub(toolAnswer("foreign"), answer("reply"));
		const original = await send(fetch, [initial]).result();
		const foreign: AssistantMessage = { ...original, api: "openai-responses", provider: "openai", model: "other" };
		const result = await send(fetch, [initial, foreign, toolResult()]).result();
		expect(result.stopReason).toBe("stop");
		expect(bodies[1].input?.slice(1)).toEqual([
			{
				type: "function_call",
				name: "lookup",
				id: "call-1",
				arguments: { region: "west" },
				signature: "skip_thought_signature_validator",
			},
			{
				type: "function_result",
				call_id: "call-1",
				name: "lookup",
				is_error: true,
				result: toolResult().content.map((part) =>
					part.type === "text" ? part : { type: "image", mime_type: part.mimeType, data: part.data },
				),
			},
		]);
	});

	it("relaxes preferred strict schema on a pre-stream validation error and remembers the fallback only for that session", async () => {
		const { fetch, bodies } = stub(
			rejection(400, "VALIDATED constraint has too many states"),
			answer("first"),
			answer("second"),
			answer("third"),
		);
		expect((await send(fetch, [initial], undefined, [strict]).result()).stopReason).toBe("stop");
		expect((await send(fetch, [initial], undefined, [strict]).result()).stopReason).toBe("stop");
		cleanupSessionResources("session");
		expect((await send(fetch, [initial], undefined, [strict]).result()).stopReason).toBe("stop");
		expect(bodies.map((body) => body.generation_config?.tool_choice)).toEqual([
			"validated",
			"auto",
			"auto",
			"validated",
		]);
		expect(bodies[0].tools?.[0]?.parameters).toMatchObject({
			additionalProperties: false,
			required: ["region", "verbose"],
		});
		expect(bodies[1].tools?.[0]?.parameters).toMatchObject({ required: ["region"] });
	});

	it("joins the SDK path to the gateway and preserves credentials, custom headers, removal, and response capture", async () => {
		const { fetch, requests, bodies } = stub(answer("gateway"));
		const baseUrl = "https://gateway.ai.cloudflare.com/v1/account/gateway/google-ai-studio/v1beta";
		const reported: number[] = [];
		const result = await streamSimple(
			{
				...model,
				baseUrl,
				headers: {
					"cf-aig-authorization": "Bearer test-gateway-key",
					"cf-aig-skip-cache": "true",
					"x-remove-me": "default",
				},
			},
			normalizeContext({ messages: [initial] }),
			{
				fetch,
				reasoning: "xhigh",
				thinkingDisplay: "omitted",
				headers: { "x-remove-me": null },
				onResponse: ({ status }) => {
					reported.push(status);
				},
			},
		).result();
		expect(result.stopReason).toBe("stop");
		expect(requests[0].url).toBe(`${baseUrl}/interactions`);
		expect(requests[0].headers.get("x-goog-api-key")).toBe("test-gateway-key");
		expect(requests[0].headers.get("cf-aig-authorization")).toBe("Bearer test-gateway-key");
		expect(requests[0].headers.get("cf-aig-skip-cache")).toBe("true");
		expect(requests[0].headers.has("x-remove-me")).toBe(false);
		expect(bodies[0].generation_config).toMatchObject({
			thinking_level: "xhigh",
			thinking_summaries: "none",
			stop_sequences: ["\nuser\n"],
		});
		expect(reported).toEqual([200]);
	});
});

describe("Google Interactions stored history", () => {
	it("sends only tool results and new user input with the current request settings", async () => {
		const { fetch, bodies } = stub(toolAnswer("tool-interaction"), answer("resumed"));
		const first = await send(fetch, [initial]).result();
		const result = await send(fetch, [initial, first, steer, toolResult(), next], {
			serviceTier: "priority",
			thinkingLevel: "high",
		}).result();
		expect(result.responseId).toBe("resumed");
		expect(bodies[1]).toMatchObject({
			previous_interaction_id: "tool-interaction",
			store: true,
			system_instruction: bodies[0].system_instruction,
			tools: bodies[0].tools,
			service_tier: "priority",
			generation_config: { thinking_level: "high" },
		});
		expect(bodies[1].input?.map((step) => step.type)).toEqual(["function_result", "user_input", "user_input"]);
	});

	it.each([
		"edited assistant",
		"edited user",
		"branch retry",
		"compacted",
		"rollover",
		"cleanup",
		"credentials changed",
	])("replays the full projected steps after %s", async (change) => {
		const { fetch, bodies } = stub(answer("first"), answer("fresh"));
		const first = await send(fetch, [initial]).result();
		const messages = [initial, first, next];
		switch (change) {
			case "edited assistant":
				messages[1] = { ...first, content: [{ type: "text", text: "New assistant content" }] };
				break;
			case "edited user":
				messages[0] = prompt("edited prompt");
				break;
			case "branch retry":
				messages.splice(1);
				break;
			case "compacted":
				messages.splice(0, 2, prompt("Summary of the prior branch"));
				break;
			case "rollover":
				messages.splice(0, 2);
				break;
			case "cleanup":
				cleanupSessionResources("session");
				break;
		}
		const final = await send(
			fetch,
			messages,
			change === "credentials changed" ? { apiKey: "rotated-key" } : undefined,
		).result();
		expect(final.stopReason).toBe("stop");
		expect(bodies[1]).toMatchObject({
			store: true,
			input: [{ type: "user_input" }, ...Array.from({ length: messages.length - 1 }, () => expect.any(Object))],
		});
		expect(bodies[1].previous_interaction_id).toBeUndefined();
		if (change === "edited assistant")
			expect(bodies[1].input?.[1]).toEqual({
				type: "model_output",
				content: [{ type: "text", text: "New assistant content" }],
			});
	});

	it.each([400, 404])("restarts a rejected stored interaction exactly once on HTTP %s", async (status) => {
		const { fetch, bodies } = stub(
			answer("expired"),
			rejection(status, "previous_interaction_id not found"),
			answer("replacement"),
			answer("continued"),
		);
		const first = await send(fetch, [initial]).result();
		const second = await send(fetch, [initial, first, next]).result();
		const third = await send(fetch, [initial, first, next, second, prompt("again")]).result();
		expect(third.stopReason).toBe("stop");
		expect(bodies.map((body) => body.previous_interaction_id)).toEqual([
			undefined,
			"expired",
			undefined,
			"replacement",
		]);
		expect(bodies[2].input?.map((step) => step.type)).toEqual(["user_input", "model_output", "user_input"]);
	});

	it.each([
		["priority", "standard"],
		["flex", "flex"],
		["standard", "standard"],
	])("warms %s as %s without touching the stored prefix", async (requested, expected) => {
		const { fetch, bodies } = stub(answer("real"), answer("warm"), answer("continued"));
		const first = await send(fetch, [initial]).result();
		const warm = await send(fetch, [initial], {
			cacheWarm: true,
			onPayload: (input) => ({ ...(input as object), service_tier: requested, background: true }),
		}).result();
		expect(warm.stopReason).toBe("stop");
		const result = await send(fetch, [initial, first, next]).result();
		expect(result.responseId).toBe("continued");
		expect(bodies[1]).toMatchObject({
			store: false,
			background: false,
			stream: true,
			service_tier: expected,
			generation_config: { max_output_tokens: 1 },
		});
		expect(bodies[1].previous_interaction_id).toBeUndefined();
		expect(bodies[2].previous_interaction_id).toBe("real");
		expect(getEffectiveCacheRetention(model, { cacheRetention: "long" })).toBe("short");
	});
});

describe("Google Interactions response stream", () => {
	it("assembles signed thought, tool search, and fragmented function steps losslessly across journal replay", async () => {
		const thinkingSignature = "dGhvdWdodA==";
		const signedCall = {
			type: "function_call",
			name: "lookup",
			id: "call-1",
			arguments: {},
			signature: "Y2FsbA==",
		} as const;
		const { fetch, bodies } = stub(
			sse(
				{ event_type: "interaction.created", interaction: { id: "tool", status: "in_progress" } },
				begin(0, { type: "thought" }),
				delta(0, { type: "thought_summary", content: { type: "text", text: "Looking " } }),
				delta(0, { type: "thought_summary", content: { type: "text", text: "up" } }),
				delta(0, { type: "thought_signature", signature: thinkingSignature }),
				end(0),
				begin(1, { type: "tool_search_call", id: "search-1", arguments: {} }),
				delta(1, {
					type: "tool_search_call",
					arguments: { function_names: ["lookup"] },
					signature: "search-signature",
				}),
				end(1),
				begin(2, { type: "tool_search_result", call_id: "search-1" }),
				delta(2, { type: "tool_search_result", result: [{ type: "function", name: "lookup" }] }),
				end(2),
				begin(3, signedCall),
				delta(3, { type: "arguments_delta", arguments: '{"region":' }),
				delta(3, { type: "arguments_delta", arguments: '"west"}' }),
				end(3),
				{ event_type: "interaction.status_update", interaction_id: "tool", status: "requires_action" },
				completed("tool", "requires_action"),
			),
			answer("replayed"),
			answer("edited"),
		);
		const events = send(fetch, [initial], { store: false });
		const eventTypes: string[] = [];
		for await (const event of events) eventTypes.push(event.type);
		const first = await events.result();
		expect(first.stopReason).toBe("toolUse");
		expect(first.content).toEqual([
			{ type: "thinking", thinking: "Looking up", thinkingSignature },
			{
				type: "toolCall",
				name: "lookup",
				id: "call-1",
				arguments: { region: "west" },
				thoughtSignature: signedCall.signature,
			},
		]);
		expect(eventTypes).toEqual([
			"start",
			"thinking_start",
			"thinking_delta",
			"thinking_delta",
			"thinking_end",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_delta",
			"toolcall_end",
			"done",
		]);
		const result = await send(fetch, [initial, JSON.parse(JSON.stringify(first)), toolResult()], {
			store: false,
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(bodies[1].input?.slice(1, -1)).toEqual([
			{ type: "thought", summary: [{ type: "text", text: "Looking up" }], signature: thinkingSignature },
			{
				type: "tool_search_call",
				id: "search-1",
				arguments: { function_names: ["lookup"] },
				signature: "search-signature",
			},
			{ type: "tool_search_result", call_id: "search-1", result: [{ type: "function", name: "lookup" }] },
			{ ...signedCall, arguments: { region: "west" } },
		]);

		const edited: AssistantMessage = {
			...first,
			content: first.content.map((block) =>
				block.type === "toolCall" ? { ...block, arguments: { region: "east" } } : block,
			),
		};
		expect((await send(fetch, [initial, edited, toolResult()], { store: false }).result()).stopReason).toBe("stop");
		expect(bodies[2].input?.slice(1, -1)).toEqual([
			{ ...signedCall, arguments: { region: "east" }, signature: "skip_thought_signature_validator" },
		]);
	});

	it.each([true, false])(
		"continues foreground hops with store=%s and prices each hop without inflating context",
		async (store) => {
			const first = sse(
				begin(0, { type: "model_output" }),
				delta(0, { type: "text", text: "Part 1" }),
				end(0),
				completed("hop-1", "requires_continuation", {
					continuation_token: "token-1",
					service_tier: "flex",
					usage: {
						initial_input_tokens: 1000,
						total_input_tokens: 1200,
						total_cached_tokens: 900,
						total_output_tokens: 40,
						total_thought_tokens: 10,
						total_tool_use_tokens: 100,
					},
				}),
			);
			const second = sse(
				begin(0, { type: "model_output" }),
				delta(0, { type: "text", text: " part 2" }),
				end(0),
				completed("hop-2", "completed", {
					usage: {
						total_input_tokens: 1100,
						total_cached_tokens: 1000,
						total_output_tokens: 30,
						total_thought_tokens: 20,
					},
				}),
			);
			second.headers.set("x-gemini-service-tier", "priority");
			const { fetch, bodies } = stub(first, second, answer("later"));
			const result = await send(fetch, [initial], { store }).result();
			expect(result.stopReason).toBe("stop");
			expect(result.responseId).toBe("hop-2");
			expect(result.content).toEqual([
				{ type: "text", text: "Part 1" },
				{ type: "text", text: " part 2" },
			]);
			expect(result.usage).toMatchObject({
				input: 100,
				cacheRead: 900,
				output: 100,
				reasoning: 30,
				totalTokens: 1100,
			});
			expect(result.usage.cost.input).toBeCloseTo((400 * 3 * 0.5 + 100 * 3 * 1.8) / 1e6, 13);
			expect(result.usage.cost.output).toBeCloseTo((50 * 15 * 0.5 + 50 * 15 * 1.8) / 1e6, 13);
			expect(result.usage.cost.cacheRead).toBeCloseTo((900 * 0.15 * 0.5 + 1000 * 0.15 * 1.8) / 1e6, 13);
			expect(bodies[1].continuation_token).toBe("token-1");
			expect(bodies[1].previous_interaction_id).toBe(store ? "hop-1" : undefined);
			expect(bodies[1].input).toEqual(store ? undefined : bodies[0].input);
			await send(fetch, [initial, result, next], { store }).result();
			expect(bodies[2].previous_interaction_id).toBe(store ? "hop-2" : undefined);
		},
	);

	it("honors disableContinuation and reports incomplete, terminal failures, and SSE errors", async () => {
		const { fetch } = stub(
			sse(completed("one", "requires_continuation", { continuation_token: "not-used" })),
			sse(completed("two", "incomplete")),
			sse(completed("three", "budget_exceeded")),
			sse({ event_type: "error", error: { message: "Google decode failed", code: "decode_failure" } }),
		);
		const stopped = await send(fetch, [initial], { disableContinuation: true }).result();
		expect(stopped).toMatchObject({
			stopReason: "length",
			rawStopReason: "requires_continuation",
		});
		expect(isRecoverableLength(stopped, model.maxTokens)).toBe(false);
		expect(await send(fetch, [initial]).result()).toMatchObject({
			stopReason: "length",
			rawStopReason: "incomplete",
		});
		expect(await send(fetch, [initial]).result()).toMatchObject({
			stopReason: "error",
			rawStopReason: "budget_exceeded",
		});
		expect(await send(fetch, [initial]).result()).toMatchObject({
			stopReason: "error",
			rawStopReason: "decode_failure",
			errorMessage: "Google decode failed",
		});
	});
});

describe("Google Interactions provider registration", () => {
	it("dispatches background submission, deferred fetch and cancel through the mixed Google provider", async () => {
		const models = createModels();
		models.setProvider(googleProvider());
		const neon = models.getModel("google", "gemini-4-neon");
		expect(neon).toMatchObject({ api: "google-interactions", promptCache: { short: 75 } });
		expect(models.getModel("google", "gemini-4-carbon")?.api).toBe("google-generative-ai");
		expect(getMidConvoToolSupport(neon)).toBe("none");
		const { fetch, bodies, requests } = stub(
			Response.json({ id: "job", model: model.id, status: "queued" }),
			Response.json({ id: "job", model: model.id, status: "in_progress" }),
			Response.json({
				id: "job",
				model: model.id,
				status: "completed",
				steps: [
					{ type: "user_input", content: [{ type: "text", text: "Do not echo this" }] },
					{ type: "function_result", call_id: "call-1", result: "Do not echo this either" },
					{ type: "thought", signature: "deferred-signature" },
					{ type: "model_output", content: [{ type: "text", text: "Background answer" }] },
				],
			}),
			Response.json({ id: "job", status: "cancelled" }),
		);
		const options = { fetch, apiKey: "offline-key", maxRetries: 0 };
		const submitted = await models
			.streamSimple(model, { messages: [initial] }, { ...options, deferred: true })
			.result();
		expect(submitted.stopReason).toBe("deferred");
		const handle = submitted.deferred;
		if (!handle) throw new Error("Missing deferred handle");
		expect(bodies[0]).toMatchObject({ background: true, store: true, stream: false });
		const pending = await models.fetchDeferred(model, handle, options);
		expect(pending).toMatchObject({ stopReason: "deferred", deferred: handle });
		const ready = await models.fetchDeferred(model, handle, options);
		expect(ready).toMatchObject({
			stopReason: "stop",
			content: [
				{ type: "thinking", thinking: "", thinkingSignature: "deferred-signature" },
				{ type: "text", text: "Background answer" },
			],
		});
		expect(ready.googleInteractionsReplay?.steps.map((step) => step.type)).toEqual(["thought", "model_output"]);
		await models.cancelDeferred(model, handle, options);
		expect(new URL(requests[2].url).searchParams.has("include_input")).toBe(false);
		expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
			["POST", "/v1beta/interactions"],
			["GET", "/v1beta/interactions/job"],
			["GET", "/v1beta/interactions/job"],
			["POST", "/v1beta/interactions/job/cancel"],
		]);
	});
});
