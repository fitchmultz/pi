import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
	type CacheRetention,
	fauxAssistantMessage,
	fauxToolCall,
	hasApi,
	InMemoryModelsStore,
	type Model,
	type Provider,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { streamSimple as codexStream } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { streamSimple as completionsStream } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as responsesStream } from "@earendil-works/pi-ai/api/openai-responses";
import { getBuiltinModel, getBuiltinModelDataGeneratedAt } from "@earendil-works/pi-ai/providers/all";
import { Container } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { expect, it, type MockInstance, vi } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { getPromptCacheTtlMs } from "../../src/core/cache-warmer.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import {
	createCodemodeExtension,
	type ExtensionAPI,
	type InstructionGroupCollector,
	instructionGroupsExtension,
} from "../../src/index.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { createHarness } from "./harness.ts";

interface Payload {
	input?: unknown[];
	messages?: unknown[];
	tools?: unknown[];
	instructions?: string;
}

// Serializers stop before transport; this is prefix evidence, not a live cache-hit measurement.
it.each([
	{ model: getBuiltinModel("openai", "gpt-6.1-sol"), systemPatches: true, toolAdditions: true, scriptOnly: false },
	{
		model: getBuiltinModel("openai-codex", "gpt-6.1-sol"),
		systemPatches: true,
		toolAdditions: true,
		scriptOnly: false,
	},
	{
		model: getBuiltinModel("cloudflare-ai-gateway", "gpt-6-astra"),
		systemPatches: true,
		toolAdditions: true,
		scriptOnly: false,
	},
	{ model: getBuiltinModel("zai", "glm-5.3"), systemPatches: false, toolAdditions: false, scriptOnly: true },
	{
		model: getBuiltinModel("deepseek", "deepseek-flash"),
		systemPatches: false,
		toolAdditions: false,
		scriptOnly: true,
	},
	{
		model: getBuiltinModel("deepseek", "deepseek-v4-pro"),
		systemPatches: true,
		toolAdditions: false,
		scriptOnly: false,
	},
] as const)(
	"$model.provider/$model.id preserves supported discovery prefixes and uses native fallback when needed",
	async ({ model, systemPatches, toolAdditions, scriptOnly }) => {
		const captures: Payload[] = [];
		const capture = async (context: TranscriptContext) => {
			const options = {
				apiKey: `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url")}.x`,
				onPayload(value: unknown) {
					captures.push(JSON.parse(JSON.stringify(value)) as Payload);
					throw new Error("offline payload captured");
				},
			};
			const stream = hasApi(model, "openai-responses")
				? responsesStream(model, context, options)
				: hasApi(model, "openai-codex-responses")
					? codexStream(model, context, options)
					: completionsStream(model, context, options);
			const result = await stream.result();
			expect(result.errorMessage).toContain("offline payload captured");
		};
		let owner!: ExtensionAPI;
		const h = await createHarness({
			initialActiveToolNames: scriptOnly ? ["codemode"] : [],
			extensionFactories: [
				...(scriptOnly ? [createCodemodeExtension({ mode: "only" })] : []),
				instructionGroupsExtension,
				(pi) => {
					owner = pi;
					pi.registerTool({
						name: "browse",
						label: "Browse",
						description: "Inspect a page",
						exposure: scriptOnly ? "deferred" : "direct",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "page inspected" }], details: undefined }),
					});
					pi.events.on("pi:instruction-groups", (data) => {
						const collector = data as InstructionGroupCollector;
						collector.register({
							name: "browser",
							description: "Browser",
							tools: ["browse"],
							instructions: () => "Inspect before acting.",
						});
						collector.register({
							name: "later",
							description: "Late connection",
							tools: ["late"],
							instructions: () => "Full late guidance.",
						});
					});
				},
			],
		});
		try {
			await h.session.bindExtensions({});
			const discovery = (args: { enable?: string[] }) =>
				fauxAssistantMessage(
					scriptOnly
						? fauxToolCall("codemode", { code: `return await tools.discover_tools(${JSON.stringify(args)});` })
						: fauxToolCall("discover_tools", args),
					{ stopReason: "toolUse" },
				);
			h.setResponses([
				async (context) => {
					await capture(context);
					return discovery({});
				},
				async (context) => {
					await capture(context);
					return discovery({ enable: ["browser"] });
				},
				async (context) => {
					await capture(context);
					return fauxAssistantMessage("done");
				},
				async (context) => {
					await capture(context);
					return fauxAssistantMessage("continued");
				},
				async (context) => {
					await capture(context);
					return fauxAssistantMessage("reconnected");
				},
			]);
			await h.session.prompt("Enable browser");
			await h.session.prompt("Continue after enabling");
			owner.registerTool({
				name: "late",
				label: "Late",
				description: "Connected later",
				exposure: "deferred",
				parameters: Type.Object({}),
				execute: async () => ({ content: [], details: undefined }),
			});
			await h.session.prompt("After reconnect");
			expect(captures).toHaveLength(5);
			const [before, listed, enabled, continued, reconnected] = captures;
			const messages = (payload: Payload) => payload.input ?? payload.messages ?? [];
			expect(JSON.stringify(messages(listed).slice(0, messages(before).length))).toBe(
				JSON.stringify(messages(before)),
			);
			expect(JSON.stringify(listed.tools)).toBe(JSON.stringify(before.tools));
			if (systemPatches) {
				for (let index = 1; index < captures.length; index++) {
					const previous = captures[index - 1];
					const current = captures[index];
					expect(JSON.stringify(messages(current).slice(0, messages(previous).length))).toBe(
						JSON.stringify(messages(previous)),
					);
					expect(current.instructions).toBe(before.instructions);
				}
				expect(JSON.stringify(messages(reconnected).slice(messages(continued).length))).toContain(
					"- later: Late connection",
				);
			} else {
				expect(JSON.stringify(messages(reconnected)[0])).toContain("- later: Late connection");
				expect(JSON.stringify(messages(reconnected)[0])).not.toBe(JSON.stringify(messages(continued)[0]));
			}
			if (toolAdditions || scriptOnly) {
				for (const payload of captures) expect(JSON.stringify(payload.tools)).toBe(JSON.stringify(before.tools));
				if (toolAdditions) {
					expect(JSON.stringify(enabled.input)).toContain('"type":"additional_tools"');
					expect(JSON.stringify(enabled.input)).toContain('"name":"browse"');
				}
			} else {
				// System-only support still needs the current tools at the top level.
				expect(JSON.stringify(enabled.tools)).toContain('"name":"browse"');
				expect(JSON.stringify(enabled.tools)).not.toBe(JSON.stringify(before.tools));
				for (const payload of captures.slice(2))
					expect(JSON.stringify(payload.tools)).toBe(JSON.stringify(enabled.tools));
			}
			expect(JSON.stringify(before)).toContain("- browser: Browser");
			expect(JSON.stringify(before)).toContain(scriptOnly ? "codemode: " : "discover_tools: ");
			if (scriptOnly) expect(JSON.stringify(before)).not.toContain("discover_tools: ");
			expect(JSON.stringify(before)).not.toContain("Inspect before acting.");
			expect(JSON.stringify(enabled)).toContain("Inspect before acting.");
			expect(JSON.stringify(before)).not.toContain('"name":"browse"');
			expect(JSON.stringify(listed)).not.toContain('"name":"browse"');
			expect(JSON.stringify(continued)).not.toContain("- later: Late connection");
			expect(h.session.getActiveToolNames().includes("browse")).toBe(!scriptOnly);
			expect(h.session.getActiveToolNames()).not.toContain("late");
		} finally {
			h.cleanup();
		}
	},
);

it("keeps abandoned branch usage in /session while reporting cache overlap only from native ancestry", async () => {
	const h = await createHarness({ initialActiveToolNames: [], settings: { cacheWarming: "off" } });
	try {
		initTheme("dark");
		const root = h.sessionManager.appendMessage({ role: "user", content: "root", timestamp: 0 });
		const paidResponse = (model: string, tokens: number, cost: number) => ({
			...fauxAssistantMessage("done"),
			model,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: tokens,
				totalTokens: tokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: cost, total: cost },
			},
		});
		h.sessionManager.appendMessage(paidResponse("direct", 100_000, 0.375));
		h.sessionManager.appendMessage(paidResponse("direct", 110_000, 0.4125));
		h.sessionManager.branch(root);
		h.sessionManager.appendMessage(paidResponse(h.getModel().id, 25_000, 0.09375));
		h.sessionManager.appendMessage(paidResponse("other-model", 30_000, 0.1125));

		const context = {
			session: h.session,
			sessionManager: h.sessionManager,
			settingsManager: h.settingsManager,
			chatContainer: new Container(),
			ui: { requestRender() {} },
		};
		const showSession = Reflect.get(InteractiveMode.prototype, "handleSessionCommand") as (
			this: typeof context,
		) => void;
		showSession.call(context);
		const output = stripAnsi(context.chatContainer.render(220).join("\n"));
		// Real accounting retains all four recorded responses: 265k tokens and $0.99375.
		expect(h.session.getSessionStats().tokens.cacheWrite).toBe(265_000);
		expect(h.session.getSessionStats().cost).toBeCloseTo(0.99375, 8);
		expect(output).toContain("Total: $0.994");
		// Estimates compare 100k on the old branch and 25k on the new branch, not 25k at its first turn.
		expect(output).toContain("Cache overlap estimate (all branches): 125,000 tokens, 2 requests");
		expect(output).toContain("Includes 1 expected model/provider transition");
		expect(output).toContain("Estimated extra cache cost: unknown");
		expect(output).toContain("Read price unknown for 2 requests");
		expect(output).toContain("not measured waste or provider billing");
		expect(output).not.toMatch(/re-billed/i);
	} finally {
		h.cleanup();
	}
});

interface NativeTool {
	name: string;
	defer_loading?: boolean;
	input_schema: { properties?: Record<string, unknown>; required?: string[] };
}

interface NativeBlock {
	type: string;
	text?: string;
	cache_control?: { type: string; ttl?: string };
	tool?: { type: string; name?: string; definition?: NativeTool };
}

interface NativeMessage {
	role: string;
	content: NativeBlock[];
	output_config?: { effort: string };
}

interface NativePayload {
	model: string;
	system?: NativeBlock[];
	tools?: NativeTool[];
	messages: NativeMessage[];
	output_config?: { effort: string };
	thinking?: { type: string; block_binding?: { prefix_mismatch_behavior: string } };
}

// Real SDK/provider serialization, with offline transport; this does not qualify signed replay or live cache hits.
it.each([
	{ source: "direct", native: true, shortTtlMs: 300_000, longTtlMs: 3_600_000 },
	{ source: "public-generated", native: true, shortTtlMs: 300_000, longTtlMs: 3_600_000 },
	{ source: "bundled", native: true, shortTtlMs: 300_000, longTtlMs: 3_600_000 },
	{ source: "restored", native: true, shortTtlMs: 300_000, longTtlMs: 3_600_000 },
	{ source: "fetched", native: true, shortTtlMs: 300_000, longTtlMs: 3_600_000 },
	{ source: "remote-false", native: false, shortTtlMs: 113_000, longTtlMs: undefined },
	{ source: "user-false", native: false, shortTtlMs: 300_000, longTtlMs: 1_800_000 },
	{ source: "custom-endpoint", native: false, shortTtlMs: undefined, longTtlMs: undefined },
	{ source: "unrelated-model", native: false, shortTtlMs: undefined, longTtlMs: undefined },
	{ source: "restored-values", native: true, shortTtlMs: 93_000, longTtlMs: 5_400_000 },
	{ source: "restored-empty", native: true, shortTtlMs: undefined, longTtlMs: undefined },
	{ source: "restored-short", native: true, shortTtlMs: 79_000, longTtlMs: undefined },
	{ source: "user-empty", native: false, shortTtlMs: undefined, longTtlMs: undefined },
] as const)(
	"$source Anthropic catalog preserves native SDK prefixes, cache lifetimes and user opt-outs",
	async ({ source, native, shortTtlMs, longTtlMs }) => {
		let owner!: ExtensionAPI;
		const h = await createHarness({
			models: [{ id: "journal-driver", reasoning: true }],
			settings: { cacheWarming: "off", compaction: { enabled: false } },
			initialActiveToolNames: [],
			extensionFactories: [
				instructionGroupsExtension,
				(pi) => {
					owner = pi;
					pi.registerTool({
						name: "browse",
						label: "Browse",
						description: "Inspect a page",
						parameters: Type.Object({ url: Type.String() }),
						execute: async () => ({ content: [{ type: "text", text: "inspected" }], details: undefined }),
					});
					pi.events.on("pi:instruction-groups", (data) => {
						const collector = data as InstructionGroupCollector;
						collector.register({
							name: "browser",
							description: "Browser",
							tools: ["browse"],
							instructions: () => "Inspect before acting.",
						});
						collector.register({
							name: "later",
							description: "Late connection",
							tools: ["late"],
							instructions: () => "Full late guidance.",
						});
					});
				},
			],
		});
		let sdk: Awaited<ReturnType<typeof createAgentSession>> | undefined;
		let preparation: MockInstance<Provider["streamSimple"]> | undefined;
		const catalogFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			throw new Error("Unexpected network request");
		});
		try {
			const provider = source === "direct" ? "anthropic" : "cloudflare-ai-gateway";
			const publicModel = getBuiltinModel(provider, "claude-opus-5-5");
			const old: Model<"anthropic-messages"> = {
				...publicModel,
				id: "claude-opus-5.5",
				compat: { ...publicModel.compat },
				headers: { ...publicModel.headers, "x-catalog-source": source },
			};
			delete old.compat?.supportsMidConvoSystemMessages;
			delete old.compat?.supportsMidConvoToolChanges;
			delete old.compat?.supportsMidConvoEffort;
			delete old.compat?.forceAdaptiveThinking;
			delete old.promptCache;
			const optOut = {
				supportsMidConvoSystemMessages: false,
				supportsMidConvoToolChanges: false,
				supportsMidConvoEffort: false,
				forceAdaptiveThinking: false,
			};
			if (source === "remote-false") {
				old.compat = { ...old.compat, ...optOut };
				old.promptCache = { short: 113 };
			}
			if (source === "restored-values") old.promptCache = { short: 93, long: 5400 };
			if (source === "restored-empty") old.promptCache = {};
			if (source === "restored-short") old.promptCache = { short: 79 };
			if (source === "custom-endpoint") old.baseUrl = "https://proxy.invalid/anthropic";
			if (source === "unrelated-model") old.id = "claude-opus-4.6";
			const generatedAt = getBuiltinModelDataGeneratedAt();
			if (generatedAt === undefined) throw new Error("Bundled catalog has no generation timestamp");
			const newer = generatedAt + 2000;
			const store = new InMemoryModelsStore();
			const restored =
				source === "restored" ||
				source.startsWith("restored-") ||
				source === "remote-false" ||
				source === "custom-endpoint" ||
				source === "unrelated-model";
			if (restored) await store.write(provider, { models: [old], lastModified: newer });
			const credentials = AuthStorage.inMemory();
			await credentials.modify(provider, async () => ({
				type: "api_key",
				key: "offline-gateway-key",
				env: { CLOUDFLARE_ACCOUNT_ID: "offline-account", CLOUDFLARE_GATEWAY_ID: "offline-gateway" },
			}));
			const modelsPath = source.startsWith("user-") ? join(h.tempDir, "models.json") : null;
			if (modelsPath) {
				writeFileSync(
					modelsPath,
					JSON.stringify({
						providers: {
							[provider]: {
								models:
									source === "user-empty"
										? [{ id: "claude-opus-5-5", reasoning: true, promptCache: {} }]
										: undefined,
								modelOverrides: {
									"claude-opus-5-5": {
										compat: optOut,
										...(source === "user-false" ? { promptCache: { long: 1800 } } : {}),
										headers: { "x-user-override": "kept" },
									},
								},
							},
						},
					}),
				);
			}
			const runtime = await ModelRuntime.create({
				credentials,
				modelsPath,
				modelsStore: store,
				allowModelNetwork: false,
				catalogBaseUrl: "https://catalog.invalid",
			});
			if (source === "fetched") {
				catalogFetch.mockImplementation(async (input, init) => {
					const request = new Request(input, init);
					expect(new URL(request.url).pathname).toBe("/api/models/providers/cloudflare-ai-gateway");
					return new Response(JSON.stringify([old]), {
						headers: { "last-modified": new Date(newer).toUTCString() },
					});
				});
				runtime.setOffline(false);
				const refreshed = await runtime.refresh({ providers: [provider], allowNetwork: true, force: true });
				expect(refreshed.errors.size).toBe(0);
				expect(catalogFetch).toHaveBeenCalledTimes(1);
				runtime.setOffline(true);
			} else {
				expect(catalogFetch).not.toHaveBeenCalled();
			}
			const id = source === "unrelated-model" ? "claude-opus-4-6" : "claude-opus-5-5";
			const model =
				source === "public-generated" || source === "direct" ? publicModel : runtime.getPhysicalModel(provider, id);
			if (!model || !hasApi(model, "anthropic-messages")) throw new Error("Missing native Cloudflare model");
			const preparedProvider = runtime.getProvider(provider);
			if (!preparedProvider) throw new Error("Missing Cloudflare provider");
			preparation = vi.spyOn(preparedProvider, "streamSimple");
			sdk = await createAgentSession({
				cwd: h.tempDir,
				agentDir: h.tempDir,
				model,
				modelRuntime: runtime,
				thinkingLevel: "high",
				settingsManager: SettingsManager.inMemory({ cacheWarming: "off" }),
				sessionManager: SessionManager.inMemory(h.tempDir),
				resourceLoader: createTestResourceLoader(),
				tools: [],
			});
			const captures: NativePayload[] = [];
			const headers: Headers[] = [];
			const urls: string[] = [];
			const failures: string[] = [];
			const fetch: typeof globalThis.fetch = async (input, init) => {
				const request = new Request(input, init);
				urls.push(request.url);
				headers.push(request.headers);
				const payload =
					request.headers.get("content-encoding") === "gzip"
						? JSON.parse(gunzipSync(Buffer.from(await request.arrayBuffer())).toString("utf8"))
						: await request.json();
				captures.push(payload as NativePayload);
				const events = [
					{
						type: "message_start",
						message: {
							id: "offline",
							type: "message",
							role: "assistant",
							content: [],
							model: id,
							stop_reason: null,
							stop_sequence: null,
							usage: { input_tokens: 1, output_tokens: 0 },
						},
					},
					{
						type: "message_delta",
						delta: { stop_reason: "end_turn", stop_sequence: null },
						usage: { output_tokens: 1 },
					},
					{ type: "message_stop" },
				];
				return new Response(
					events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
					{
						headers: { "content-type": "text/event-stream" },
					},
				);
			};
			const capture = async (
				context: TranscriptContext,
				reasoning: "high" | "low" = "high",
				cacheRetention: CacheRetention = "short",
			) => {
				const stream = await sdk!.session.agent.streamFunction(model, context, {
					fetch,
					reasoning,
					cacheRetention,
				});
				const result = await stream.result();
				if (result.stopReason !== "stop") failures.push(result.errorMessage ?? result.stopReason);
			};
			let continuationContext: TranscriptContext | undefined;
			await h.session.bindExtensions({});
			h.setResponses([
				async (context) => {
					await capture(context);
					return fauxAssistantMessage(fauxToolCall("discover_tools", {}), { stopReason: "toolUse" });
				},
				async (context) => {
					await capture(context);
					return fauxAssistantMessage("listed");
				},
				async (context) => {
					await capture(context);
					return fauxAssistantMessage(fauxToolCall("discover_tools", { enable: ["browser"] }), {
						stopReason: "toolUse",
					});
				},
				async (context) => {
					await capture(context);
					return fauxAssistantMessage("discovered");
				},
				async (context) => {
					await capture(context);
					return fauxAssistantMessage("redefined");
				},
				async (context) => {
					await capture(context);
					return fauxAssistantMessage("removed");
				},
				async (context) => {
					continuationContext = context;
					await capture(context, "low");
					return fauxAssistantMessage("continued");
				},
				async (context) => {
					continuationContext = context;
					await capture(context, "low");
					return fauxAssistantMessage("reconnected");
				},
			]);
			await h.session.prompt("Prime");
			await h.session.prompt("Discover browser");
			owner.registerTool({
				name: "browse",
				label: "Browse",
				description: "Find an element",
				parameters: Type.Object({ selector: Type.String() }),
				execute: async () => ({ content: [{ type: "text", text: "found" }], details: undefined }),
			});
			await h.session.prompt("Use the new definition");
			h.session.setActiveToolsByName(["discover_tools"]);
			await h.session.prompt("Withdraw browser");
			await h.session.prompt("Continue at low effort");
			owner.registerTool({
				name: "late",
				label: "Late",
				description: "Connected later",
				exposure: "deferred",
				parameters: Type.Object({}),
				execute: async () => ({ content: [], details: undefined }),
			});
			await h.session.prompt("After reconnect");
			expect(failures).toEqual([]);
			expect(captures).toHaveLength(8);
			for (const url of urls) {
				expect(url).toBe(
					source === "direct"
						? "https://api.anthropic.com/v1/messages?beta=true"
						: source === "custom-endpoint"
							? "https://proxy.invalid/anthropic/v1/messages?beta=true"
							: "https://gateway.ai.cloudflare.com/v1/offline-account/offline-gateway/anthropic/v1/messages?beta=true",
				);
			}
			const [prime, listed, append, discovered, redefined, removed, low, reconnected] = captures;
			const blocks = (payload: NativePayload) => payload.messages.flatMap((message) => message.content);
			expect(JSON.stringify(prime.system)).toContain("- browser: Browser");
			expect(JSON.stringify(prime.system)).toContain("discover_tools: ");
			expect(JSON.stringify(prime)).not.toContain("Inspect before acting.");
			expect(JSON.stringify(listed)).not.toContain("Inspect before acting.");
			expect(JSON.stringify(low)).not.toContain("- later: Late connection");
			expect(JSON.stringify(reconnected)).toContain("- later: Late connection");
			expect(h.session.getActiveToolNames()).not.toContain("late");
			const betas = [
				"inline-tools-2026-09-15",
				"mid-conversation-output-config-2026-07-01",
				"thinking-binding-controls-2026-08-01",
			];
			for (const [index, payload] of captures.entries()) {
				expect(payload.model).toBe(id);
				expect(headers[index].get("cf-aig-authorization")).toBe(
					source === "direct" ? null : "Bearer offline-gateway-key",
				);
				expect(headers[index].has("authorization")).toBe(false);
				expect(headers[index].get("x-api-key")).toBe(source === "direct" ? "offline-gateway-key" : null);
				if (restored || source === "fetched") expect(headers[index].get("x-catalog-source")).toBe(source);
				if (source.startsWith("user-")) expect(headers[index].get("x-user-override")).toBe("kept");
			}
			if (native) {
				for (const payload of captures.slice(1)) {
					expect(JSON.stringify(payload.tools)).toBe(JSON.stringify(prime.tools));
					expect(JSON.stringify(payload.system)).toBe(JSON.stringify(prime.system));
				}
				expect(prime.tools).toEqual([
					expect.objectContaining({ name: "discover_tools" }),
					expect.objectContaining({ name: "__pi_deferred_placeholder__", defer_loading: true }),
				]);
				expect(prime.tools?.[0].defer_loading).toBeUndefined();
				// Moving cache breakpoints and the final request-local effort control are not semantic history.
				const semanticMessages = (payload: NativePayload) =>
					JSON.parse(
						JSON.stringify(payload.messages.slice(0, -1), (key, value: unknown) =>
							key === "cache_control" ? undefined : value,
						),
					) as NativeMessage[];
				for (let index = 1; index < captures.length; index++) {
					const before = semanticMessages(captures[index - 1]);
					const after = semanticMessages(captures[index]);
					expect(JSON.stringify(after.slice(0, before.length))).toBe(JSON.stringify(before));
				}
				expect(blocks(append).some((block) => block.type === "tool_addition")).toBe(false);
				const addition = blocks(discovered).find((block) => block.type === "tool_addition");
				expect(addition?.tool?.definition).toMatchObject({
					name: "browse",
					input_schema: { properties: { url: { type: "string" } }, required: ["url"] },
				});
				const additionIndex = discovered.messages.findIndex((message) =>
					message.content.some((block) => block.type === "tool_addition"),
				);
				const discoveryResultIndex = discovered.messages.findIndex((message) =>
					message.content.some((block) => block.type === "tool_result"),
				);
				expect(discoveryResultIndex).toBeGreaterThan(-1);
				expect(additionIndex).toBeGreaterThan(discoveryResultIndex);
				expect(discovered.messages[additionIndex].role).toBe("system");
				const additions = blocks(redefined).filter((block) => block.type === "tool_addition");
				expect(additions).toHaveLength(2);
				expect(additions[1].tool?.definition).toMatchObject({
					name: "browse",
					input_schema: { properties: { selector: { type: "string" } }, required: ["selector"] },
				});
				expect(additions[1].tool?.definition?.input_schema.properties).not.toHaveProperty("url");
				const redefinitionIndex = redefined.messages.findIndex((message) =>
					message.content.some((block) =>
						Object.hasOwn(block.tool?.definition?.input_schema.properties ?? {}, "selector"),
					),
				);
				expect(redefinitionIndex).toBeGreaterThan(
					redefined.messages.findIndex((message) => message.content.some((block) => block.text === "discovered")),
				);
				expect(blocks(removed).find((block) => block.type === "tool_removal")?.tool).toEqual({
					type: "tool_reference",
					name: "browse",
				});
				const removalIndex = removed.messages.findIndex((message) =>
					message.content.some((block) => block.type === "tool_removal"),
				);
				expect(removalIndex).toBeGreaterThan(
					removed.messages.findIndex((message) => message.content.some((block) => block.text === "redefined")),
				);
				for (const [index, payload] of captures.entries()) {
					expect(payload.output_config).toEqual({ effort: "high" });
					expect(payload.thinking).toMatchObject({
						type: "adaptive",
						block_binding: { prefix_mismatch_behavior: "drop_block" },
					});
					expect(payload.messages.at(-1)).toEqual({
						role: "system",
						content: [],
						output_config: { effort: index >= 6 ? "low" : "high" },
					});
				}
			} else {
				expect(discovered.tools?.find((tool) => tool.name === "browse")?.input_schema).toMatchObject({
					properties: { url: { type: "string" } },
				});
				expect(redefined.tools?.find((tool) => tool.name === "browse")?.input_schema).toMatchObject({
					properties: { selector: { type: "string" } },
				});
				expect(removed.tools?.some((tool) => tool.name === "browse")).toBe(false);
				expect(redefined.system).not.toEqual(prime.system);
				for (const payload of captures) {
					expect(payload.tools?.some((tool) => tool.defer_loading)).toBe(false);
					expect(
						blocks(payload).some((block) => block.type === "tool_addition" || block.type === "tool_removal"),
					).toBe(false);
				}
				if (source === "remote-false" || source === "user-false") expect(low.thinking?.type).toBe("enabled");
			}
			for (const header of headers) {
				for (const beta of betas) {
					if (native) expect(header.get("anthropic-beta") ?? "").toContain(beta);
					else expect(header.get("anthropic-beta") ?? "").not.toContain(beta);
				}
			}
			const [preparedModel, , preparedOptions] = preparation.mock.calls[0];
			expect(getPromptCacheTtlMs(preparedModel, preparedOptions)).toBe(shortTtlMs);
			expect(prime.system?.[0].cache_control).toEqual({ type: "ephemeral" });
			if (!continuationContext) throw new Error("Missing continuation context");
			for (const retention of ["long", "none"] as const) {
				await capture(continuationContext, "low", retention);
				const [requestModel, , requestOptions] = preparation.mock.calls.at(-1)!;
				expect(getPromptCacheTtlMs(requestModel, requestOptions)).toBe(
					retention === "long" ? longTtlMs : undefined,
				);
				expect(captures.at(-1)?.system?.[0].cache_control).toEqual(
					retention === "long" ? { type: "ephemeral", ttl: "1h" } : undefined,
				);
			}
			expect(failures).toEqual([]);
			expect(captures).toHaveLength(10);
		} finally {
			preparation?.mockRestore();
			sdk?.session.dispose();
			catalogFetch.mockRestore();
			h.cleanup();
		}
	},
);
