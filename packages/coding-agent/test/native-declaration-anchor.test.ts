import {
	fauxAssistantMessage,
	getCurrentSystemMessage,
	getCurrentTools,
	normalizeContext,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as streamCodex } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, test, vi } from "vitest";
import { loadExtensions } from "../src/core/extensions/loader.ts";
import type { ExtensionAPI, ExtensionFactory } from "../src/core/extensions/types.ts";
import { parseSessionEntries, SessionManager } from "../src/core/session-manager.ts";
import { createHarness } from "./suite/harness.ts";
import { allowNetwork } from "./test-network-env.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

const startup: ExtensionFactory = (pi) => {
	pi.on("session_start", () => pi.sendMessage({ customType: "startup", content: "POLICY", display: false }));
	pi.on("context_with_system", (event) => ({
		messages: event.messages.map((message) =>
			message.role === "custom"
				? { role: "system", content: "POLICY", timestamp: event.messages[0].timestamp }
				: message,
		),
	}));
};

// Owns startup ordering and hostile-hook recovery, not just a serializer-shaped fixture.
test.each(["prepend", "throw", "reconstruct", "restamp", "prepend-restamp", "duplicate", "remove"])(
	"anchors startup declarations after a %s hook",
	async (action) => {
		const requests: TranscriptContext[] = [];
		const errors: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				startup,
				(pi) => {
					pi.on("context_with_system", (event) => {
						const head = event.messages[0];
						if (head.role !== "system") throw new Error("Missing native head before hook");
						if (action === "prepend")
							return {
								messages: [{ role: "system", content: "OTHER POLICY", timestamp: 0 }, ...event.messages],
							};
						if (action === "remove") return { messages: structuredClone(event.messages.slice(1)) };
						// Rebuilt heads with fresh timestamps are identified by their intact declarations.
						if (action !== "duplicate" && !action.endsWith("restamp")) {
							head.toolsAdded = [];
							head.toolsRemoved = [{ name: "read" }];
						}
						head.content = "EDITED BASE";
						head.sections = { ...head.sections, extension: "EDITED CONTENT" };
						if (action === "throw") throw new Error("Hook failed after mutation");
						if (action === "reconstruct" || action.endsWith("restamp")) {
							const { nativeHead: _nativeHead, ...reconstructed } = head;
							if (action === "reconstruct") return { messages: [reconstructed, ...event.messages.slice(1)] };
							reconstructed.timestamp++;
							const policy = { role: "system" as const, content: "OTHER POLICY", timestamp: 0 };
							return {
								messages: [
									...(action === "prepend-restamp" ? [policy] : []),
									reconstructed,
									...event.messages.slice(1),
								],
							};
						}
						if (action === "duplicate")
							return {
								messages: [
									head,
									...event.messages.slice(1),
									{ ...structuredClone(head), toolsAdded: [], toolsRemoved: [{ name: "read" }] },
								],
							};
					});
				},
			],
		});
		try {
			await harness.session.bindExtensions({ onError: (error) => errors.push(error.error) });
			harness.setResponses([
				(context) => {
					requests.push(structuredClone(context));
					return fauxAssistantMessage("done");
				},
			]);
			await harness.session.prompt("one");
			expect(requests).toHaveLength(1);
			const head = requests[0].messages[0];
			expect(head).toMatchObject({
				role: "system",
				toolsAdded: expect.arrayContaining([expect.objectContaining({ name: "read" })]),
			});
			expect(head).not.toHaveProperty("nativeHead");
			expect(requests[0].messages.slice(1)).toContainEqual(
				expect.objectContaining({ role: "system", content: "POLICY" }),
			);
			expect(errors.some((error) => error.includes("Restored the native initial declaration"))).toBe(true);
			if (action !== "prepend" && action !== "remove")
				expect(head).toMatchObject({ content: "EDITED BASE", sections: { extension: "EDITED CONTENT" } });
			expect(requests[0].messages.filter((message) => message.role === "system")).toHaveLength(
				action.startsWith("prepend") ? 3 : 2,
			);
			expect(getCurrentTools(requests[0].messages).map((tool) => tool.name)).toEqual(
				harness.session.getActiveToolNames(),
			);
			const branch = harness.sessionManager.getBranch();
			expect(branch.findIndex((entry) => entry.type === "custom_message")).toBeLessThan(
				branch.findIndex((entry) => entry.type === "message" && entry.message.role === "system"),
			);
			expect(harness.sessionManager.buildSessionProjection().messages[0]).toMatchObject({ nativeHead: true });
		} finally {
			harness.cleanup();
		}
	},
);

test("keeps new policy separate when a restamped tool-less head is ambiguous", async () => {
	const requests: TranscriptContext[] = [];
	const errors: string[] = [];
	const harness = await createHarness({
		initialActiveToolNames: [],
		extensionFactories: [
			(pi) => {
				pi.on("context_with_system", (event) => {
					const head = event.messages[0];
					if (head.role !== "system" || !head.nativeHead) throw new Error("Missing native head before hook");
					const { nativeHead: _nativeHead, ...rebuilt } = head;
					// A tool-less head's declarations can equal an ordinary policy's.
					const { deferredToolEntries } = head;
					return {
						messages: [
							{ role: "system", content: "POLICY", deferredToolEntries, timestamp: 0 },
							{ ...rebuilt, content: "EDITED BASE", timestamp: rebuilt.timestamp + 1 },
							...event.messages.slice(1),
						],
					};
				});
			},
		],
	});
	try {
		await harness.session.bindExtensions({ onError: (error) => errors.push(error.error) });
		harness.setResponses([
			(context) => {
				requests.push(structuredClone(context));
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("one");
		const [head, ...rest] = requests[0].messages;
		expect(head).toMatchObject({ role: "system" });
		expect(getCurrentTools(requests[0].messages)).toEqual([]);
		// Without a unique match the saved head wins; the policy is never consumed as the head.
		expect(["POLICY", "EDITED BASE"]).not.toContain(head.role === "system" ? head.content : undefined);
		expect(rest).toContainEqual(expect.objectContaining({ role: "system", content: "POLICY" }));
		expect(errors.some((error) => error.includes("Restored the native initial declaration"))).toBe(true);
	} finally {
		harness.cleanup();
	}
});

test("forking an earlier branch retains its native declaration and startup policy", async () => {
	const requests: TranscriptContext[] = [];
	const harness = await createHarness({ extensionFactories: [startup] });
	try {
		await harness.session.bindExtensions({});
		harness.setResponses(
			["first", "abandoned", "forked"].map((text) => (context: TranscriptContext) => {
				requests.push(structuredClone(context));
				return fauxAssistantMessage(text);
			}),
		);
		await harness.session.prompt("first input");
		const forkPoint = harness.sessionManager.getLeafId()!;
		const retained = structuredClone(harness.sessionManager.buildSessionProjection().messages);
		await harness.session.prompt("abandoned input");
		const originalId = harness.session.sessionId;
		harness.sessionManager.createBranchedSession(forkPoint);
		harness.session.refreshContext();
		expect(harness.session.sessionId).not.toBe(originalId);
		expect(harness.session.messages).toEqual(retained);
		expect(harness.session.messages[0]).toMatchObject({ nativeHead: true });
		await harness.session.prompt("fork input");
		expect(requests[2].messages[0]).toEqual(requests[0].messages[0]);
		expect(requests[2].messages.filter((message) => message.role === "system")).toHaveLength(2);
		expect(JSON.stringify(requests[2].messages)).not.toContain("abandoned");
	} finally {
		harness.cleanup();
	}
});

interface WireItem {
	type?: string;
	role?: string;
	text?: string;
	content?: string | WireItem[];
	tool?: { name: string };
	tools?: { name: string }[];
}
interface WirePayload {
	system?: unknown;
	instructions?: string;
	tools: { name?: string; defer_loading?: boolean; cache_control?: unknown }[];
	messages?: WireItem[];
	input?: WireItem[];
}

async function serialize(context: TranscriptContext, api: "anthropic" | "codex"): Promise<WirePayload> {
	const model =
		api === "anthropic" ? getModel("anthropic", "claude-opus-5-5")! : getModel("openai-codex", "gpt-6-astra")!;
	expect(model).toBeDefined();
	// Faux owns runtime execution. Give its saved offline replies the target's identity for native replay.
	const messages = context.messages.map((message) =>
		message.role === "assistant"
			? { ...message, api: model.api, provider: model.provider, model: model.id }
			: message,
	);
	let payload: WirePayload | undefined;
	const options = {
		apiKey:
			api === "anthropic"
				? "offline-key"
				: `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline" } })).toString("base64url")}.x`,
		transport: "sse" as const,
		reasoningEffort: "high" as const,
		fetch: async () => {
			throw new Error("Unexpected transport");
		},
		onPayload(value: unknown) {
			payload = structuredClone(value) as WirePayload;
			throw new Error("OFFLINE_CAPTURE");
		},
	};
	const result = await (model.api === "anthropic-messages"
		? streamAnthropic(model, normalizeContext({ messages }), options)
		: streamCodex(model, normalizeContext({ messages }), options)
	).result();
	expect(result.errorMessage).toContain("OFFLINE_CAPTURE");
	expect(payload).toBeDefined();
	return payload!;
}

function additions(payload: WirePayload, api: "anthropic" | "codex"): string[] {
	return api === "anthropic"
		? (payload.messages ?? []).flatMap((message) =>
				Array.isArray(message.content)
					? message.content.flatMap((block) => (block.type === "tool_addition" ? [block.tool!.name] : []))
					: [],
			)
		: (payload.input ?? []).flatMap((item) =>
				item.type === "additional_tools" ? (item.tools ?? []).map((tool) => tool.name) : [],
			);
}

// Cross-repository integration deliberately loads the actual extension, never a copied callback.
// Run with PONYTAIL_EXTENSION_PATH=/path/to/ponytail/pi-extension/index.js.
describe.skipIf(!process.env.PONYTAIL_EXTENSION_PATH)("Ponytail native request anchoring", () => {
	for (const api of ["anthropic", "codex"] as const) {
		test.each(["fresh", "legacy-window", "legacy-compaction"])(
			`${api}: %s startup, incoming intercom and another lazy activation`,
			async (scenario) => {
				allowNetwork();
				vi.stubEnv("PONYTAIL_DEFAULT_MODE", "full");
				vi.stubEnv("PONYTAIL_QUIET_STARTUP", "1");
				const transport = vi.fn(async () => {
					throw new Error("Unexpected transport");
				});
				vi.stubGlobal("fetch", transport);
				let extensionApi!: ExtensionAPI;
				const extensions = await createTestExtensionsResult([
					(pi) => {
						extensionApi = pi;
						for (const name of ["intercom", "agent_runs"])
							pi.registerTool({
								name,
								label: name,
								description: name,
								parameters: Type.Object({}),
								execute: async () => ({ content: [], details: undefined }),
							});
						pi.on("session_start", () => pi.setActiveTools(["read"]));
					},
				]);
				const ponytail = await loadExtensions(
					[process.env.PONYTAIL_EXTENSION_PATH!],
					process.cwd(),
					undefined,
					extensions.runtime,
				);
				expect(ponytail.errors).toEqual([]);
				extensions.extensions.push(...ponytail.extensions);
				const manager = SessionManager.inMemory();
				if (scenario !== "fresh") {
					manager.appendCustomMessageEntry("ponytail-mode-update", "LEGACY POLICY", false, { id: "legacy" });
					manager.appendMessage({
						role: "system",
						content: "",
						sections: { preamble: "LEGACY NATIVE" },
						toolsAdded: [{ name: "read", description: "Read", parameters: Type.Object({}) }],
						timestamp: 1,
					});
					manager.appendMessage(fauxAssistantMessage("old bound response"));
				}
				const original = structuredClone(manager.getEntries());
				const harness = await createHarness({
					sessionManager: manager,
					tools: [
						{
							name: "read",
							label: "read",
							description: "Read",
							parameters: Type.Object({}),
							execute: async () => ({ content: [], details: undefined }),
						},
					],
					resourceLoader: createTestResourceLoader({ extensionsResult: extensions }),
					settings: { compaction: { enabled: false }, retry: { enabled: false } },
				});
				try {
					const errors: string[] = [];
					await harness.session.bindExtensions({ onError: (error) => errors.push(error.error) });
					if (scenario !== "fresh") {
						const before = await harness.session.extensionRunner.emitContext(
							manager.buildSessionProjection().messages,
						);
						expect(before[0]).toMatchObject({ role: "system", sections: { ponytail: "LEGACY POLICY" } });
						expect(before[1]).toMatchObject({ sections: { preamble: "LEGACY NATIVE" } });
						expect(manager.getEntries().slice(0, original.length)).toEqual(original);
						if (scenario === "legacy-window") harness.session.newContext({ handoff: "continue" });
						else {
							manager.appendCompaction("continue", null, 100);
							harness.session.refreshContext();
						}
						expect(manager.buildSessionProjection().messages[0]).toMatchObject({
							role: "system",
							nativeHead: true,
						});
					}
					const requests: TranscriptContext[] = [];
					const respond = () => {
						harness.setResponses([
							(context) => {
								requests.push(structuredClone(context));
								return {
									...fauxAssistantMessage([
										{
											type: "thinking",
											thinking: "offline reasoning",
											thinkingSignature:
												api === "anthropic"
													? "offline-signature"
													: JSON.stringify({
															type: "reasoning",
															id: `rs_${requests.length}`,
															summary: [],
															encrypted_content: "offline",
														}),
										},
										{ type: "text", text: "done" },
									]),
									providerThinkingLevel: "high",
								};
							},
						]);
					};
					respond();
					await harness.session.prompt("first");
					const reopened = SessionManager.inMemory(
						manager.getCwd(),
						undefined,
						parseSessionEntries(
							[manager.getHeader(), ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n"),
						),
					);
					expect(reopened.buildSessionProjection().messages).toEqual(manager.buildSessionProjection().messages);
					expect(reopened.buildSessionProjection().messages[0]).toMatchObject({ nativeHead: true });
					// Same activation and delivery boundary used by an incoming intercom message, without IPC.
					extensionApi.setActiveTools([...extensionApi.getActiveTools(), "intercom"]);
					respond();
					await harness.session.sendCustomMessage(
						{ customType: "intercom", content: "Incoming coordination", display: false },
						{ triggerTurn: true },
					);
					extensionApi.setActiveTools([...extensionApi.getActiveTools(), "agent_runs"]);
					respond();
					await harness.session.prompt("second lazy activation");
					await harness.session.prompt("/ponytail lite");
					respond();
					await harness.session.prompt("mode changed");
					expect(errors).toEqual([]);
					const payloads: WirePayload[] = [];
					for (const request of requests) payloads.push(await serialize(request, api));
					expect(payloads[0].tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: "read" })]));
					for (const payload of payloads.slice(1)) {
						expect(payload.system).toEqual(payloads[0].system);
						expect(payload.instructions).toEqual(payloads[0].instructions);
						expect(payload.tools.filter((tool) => !tool.defer_loading)).toEqual(
							payloads[0].tools.filter((tool) => !tool.defer_loading),
						);
					}
					for (const payload of payloads)
						expect(JSON.stringify(payload.messages ?? payload.input)).toContain("<ponytail>");
					expect(additions(payloads[0], api)).toEqual([]);
					expect(additions(payloads[1], api)).toEqual(["intercom"]);
					expect(additions(payloads[2], api)).toEqual(["intercom", "agent_runs"]);
					expect(additions(payloads[3], api)).toEqual(["intercom", "agent_runs"]);
					for (const [index, name, input] of [
						[1, "intercom", "Incoming coordination"],
						[2, "agent_runs", "second lazy activation"],
					] as const) {
						const wire = payloads[index].messages ?? payloads[index].input!;
						const addition = wire.findIndex((item) =>
							additions({ tools: [], messages: [item], input: [item] }, api).includes(name),
						);
						expect(addition).toBeGreaterThan(-1);
						const inputIndex = wire.findIndex((item) => JSON.stringify(item).includes(input));
						// Anthropic holds system updates until after user/tool results, immediately before the next response.
						expect(addition).toBe(inputIndex + (api === "anthropic" ? 1 : -1));
					}
					if (api === "anthropic") {
						expect(payloads[2].tools.filter((tool) => tool.defer_loading).map((tool) => tool.name)).toEqual(
							expect.arrayContaining(["intercom", "agent_runs"]),
						);
						expect(JSON.stringify(payloads[2].messages)).toContain('"type":"thinking"');
					}
					// Moving message cache breakpoints is expected; earlier serialized content and additions are not.
					for (let index = 1; index < payloads.length; index++) {
						const previous = payloads[index - 1].messages ?? payloads[index - 1].input!;
						const current = (payloads[index].messages ?? payloads[index].input!).slice(0, previous.length);
						const withoutCacheMarkers = (items: WireItem[]) =>
							JSON.stringify(items, (key, value) => (key === "cache_control" ? undefined : value));
						expect(withoutCacheMarkers(current)).toEqual(withoutCacheMarkers(previous));
					}
					expect(getCurrentSystemMessage(requests.at(-1)!.messages)?.sections?.ponytail).toContain("level: lite");
					expect(transport).not.toHaveBeenCalled();
				} finally {
					harness.cleanup();
					vi.unstubAllGlobals();
				}
			},
		);
	}
});
