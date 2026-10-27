import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Credential, Model } from "@earendil-works/pi-ai";
import { streamSimple as openaiStream } from "@earendil-works/pi-ai/api/openai-responses";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { findInitialModel, resolveCliModel } from "../src/core/model-resolver.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { InMemoryCodingAgentModelsStore } from "../src/core/models-store.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { generateBranchSummary, generateSummary } from "../src/index.ts";
import { createTestUiContext } from "./suite/harness.ts";

const ALIAS = "daybreak-blue-luna";
const luna: Model<"openai-responses"> = {
	id: "gpt-6-luna",
	name: "GPT-6 Luna",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	thinkingLevelMap: { off: "none", low: "low", high: "high" },
	input: ["text", "image"],
	cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
	contextWindow: 272_000,
	maxTokens: 12_000,
};
const apiKey: Credential = { type: "api_key", key: "sk-fake" };
const oauth: Credential = {
	type: "oauth",
	access: "fake-subscription-token",
	refresh: "fake",
	expires: Date.now() + 3_600_000,
};

function response() {
	const item = {
		type: "message",
		id: "msg-test",
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text: "ok", annotations: [] }],
	};
	const events = [
		{ type: "response.created", response: { id: "resp-test" } },
		{ type: "response.output_item.added", output_index: 0, item },
		{ type: "response.output_text.delta", output_index: 0, delta: "ok" },
		{ type: "response.output_item.done", output_index: 0, item },
		{
			type: "response.completed",
			response: {
				id: "resp-test",
				status: "completed",
				output: [item],
				usage: {
					input_tokens: 100,
					output_tokens: 1,
					total_tokens: 101,
					input_tokens_details: { cached_tokens: 0 },
				},
			},
		},
	];
	return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

describe("Daybreak Blue model alias", () => {
	const directories: string[] = [];
	const sessions: Array<{ dispose(): void }> = [];

	afterEach(() => {
		for (const session of sessions.splice(0)) session.dispose();
		vi.useRealTimers();
		vi.unstubAllGlobals();
		for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function captureRequests() {
		const requests: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
		vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = input instanceof Request ? input.url : String(input);
			let body: string | Uint8Array | undefined;
			if (input instanceof Request) body = new Uint8Array(await input.clone().arrayBuffer());
			else if (typeof init?.body === "string" || init?.body instanceof Uint8Array) body = init.body;
			if (body instanceof Uint8Array) {
				const bytes = body[0] === 0x28 && body[1] === 0xb5 ? zstdDecompressSync(body) : body;
				body = Buffer.from(bytes).toString("utf8");
			}
			if (!body) throw new Error(`Missing request body for ${url}`);
			requests.push({
				url,
				body: JSON.parse(body) as Record<string, unknown>,
				headers: new Headers(input instanceof Request ? input.headers : init?.headers),
			});
			return response();
		});
		return requests;
	}

	async function setup(
		options: {
			credential?: Credential | null;
			config?: Record<string, unknown>;
			remote?: Model<"openai-responses">;
			extension?: ExtensionFactory;
			warming?: boolean;
		} = {},
	) {
		const dir = mkdtempSync(join(tmpdir(), "pi-daybreak-"));
		directories.push(dir);
		const modelsPath = join(dir, "models.json");
		if (options.config) writeFileSync(modelsPath, JSON.stringify({ providers: { openai: options.config } }));
		const store = new InMemoryCodingAgentModelsStore();
		if (options.remote)
			await store.write("openai", { models: [options.remote], lastModified: Date.now() + 86_400_000 });
		const auth = AuthStorage.inMemory(options.credential === null ? {} : { openai: options.credential ?? apiKey });
		const runtime = await ModelRuntime.create({
			credentials: auth,
			modelsPath,
			modelsStore: store,
			allowModelNetwork: false,
		});
		const settings = SettingsManager.inMemory({
			compaction: { keepRecentTokens: 1, reserveTokens: 20 },
			cacheWarming: options.warming ? "idle" : "off",
		});
		const loader = new DefaultResourceLoader({
			cwd: dir,
			agentDir: dir,
			settingsManager: settings,
			extensionFactories: options.extension ? [options.extension] : [],
		});
		await loader.reload();
		const createSession = async (manager: SessionManager, model?: Model<"openai-responses">) => {
			const { session } = await createAgentSession({
				cwd: dir,
				agentDir: dir,
				modelRuntime: runtime,
				settingsManager: settings,
				sessionManager: manager,
				resourceLoader: loader,
				model,
				noTools: "all",
			});
			sessions.push(session);
			await session.bindExtensions({ mode: "tui", uiContext: createTestUiContext() });
			return session;
		};
		return { dir, runtime, store, auth, settings, createSession };
	}

	it("keeps default, exact, and fuzzy ordinary selections separate from the opt-in alias", async () => {
		const { runtime } = await setup();
		const get = (cliModel: string) =>
			resolveCliModel({ cliProvider: "openai", cliModel, modelRuntime: runtime }).model?.id;
		expect(get("gpt-6-luna")).toBe("gpt-6-luna");
		expect(get("gpt-6-lu")).toBe("gpt-6-luna");
		expect(get("gpt-6.1-sol")).toBe("gpt-6.1-sol");
		expect(get(ALIAS)).toBe(ALIAS);
		expect((await findInitialModel({ scopedModels: [], isContinuing: false, modelRuntime: runtime })).model?.id).toBe(
			"gpt-5.5",
		);
		expect(runtime.getModel("openai", ALIAS)?.name).toBe("Daybreak Blue (GPT-6 Luna)");
		expect(runtime.getModel("openai-codex", ALIAS)).toBeUndefined();
	});

	it("derives metadata from remote Luna after user overrides and refreshes it with the catalog", async () => {
		const remote = { ...luna, contextWindow: 400_000, cost: { ...luna.cost, input: 4 } };
		const { runtime, store } = await setup({
			remote,
			config: { modelOverrides: { "gpt-6-luna": { contextWindow: 335_000, maxTokens: 6_000, input: ["text"] } } },
		});
		const physical = runtime.getModel("openai", "gpt-6-luna")!;
		const alias = runtime.getModel("openai", ALIAS)!;
		expect(alias).toEqual({ ...physical, id: ALIAS, name: "Daybreak Blue (GPT-6 Luna)" });
		expect(alias).toMatchObject({
			contextWindow: 335_000,
			maxTokens: 6_000,
			input: ["text"],
			cost: { input: 4 },
			reasoning: true,
		});
		expect((await runtime.getAvailable("openai")).map((model) => model.id)).toContain(ALIAS);
		await store.write("openai", {
			models: [{ ...remote, cost: { ...remote.cost, input: 8 } }],
			lastModified: Date.now() + 172_800_000,
		});
		await runtime.refresh({ providers: ["openai"], allowNetwork: false });
		expect(runtime.getModel("openai", ALIAS)).toMatchObject({ contextWindow: 335_000, cost: { input: 8 } });
	});

	it.each([
		["API key", apiKey],
		["Sign in with ChatGPT", oauth],
	] as const)("serializes only the selected alias with %s", async (_kind, credential) => {
		const requests = captureRequests();
		const { runtime, dir, createSession } = await setup({ credential });
		if (credential.type === "oauth") {
			const available = await runtime.getAllAvailable("openai");
			expect(available.some((model) => model.id === ALIAS && model.type !== "classifier")).toBe(true);
			expect(available.some((model) => model.type === "classifier")).toBe(false);
		}
		const session = await createSession(SessionManager.create(dir, join(dir, "sessions")));
		await session.setModel(runtime.getModel("openai", "gpt-6-luna")!);
		await session.prompt("normal luna");
		await session.setModel(runtime.getModel("openai", ALIAS)!);
		await session.prompt("blue luna");
		await session.setModel(runtime.getModel("openai", "gpt-6.1-sol")!);
		await session.prompt("normal sol");
		expect(requests.map(({ url, body }) => [url, body.model, body.access_programs])).toEqual([
			["https://api.openai.com/v1/responses", "gpt-6-luna", undefined],
			["https://api.openai.com/v1/responses", "gpt-6-luna", { cyber: "daybreak_blue" }],
			["https://api.openai.com/v1/responses", "gpt-6.1-sol", undefined],
		]);
		const assistant = session.messages.filter((message) => message.role === "assistant");
		expect(assistant.map((message) => [message.model, message.stopReason])).toEqual([
			["gpt-6-luna", "stop"],
			[ALIAS, "stop"],
			["gpt-6.1-sol", "stop"],
		]);
	});

	it("applies alias fields after sampling and before extension hooks while retaining Luna headers", async () => {
		const requests = captureRequests();
		const observed: unknown[] = [];
		const extension: ExtensionFactory = (pi) => {
			pi.on("before_provider_request", (event) => {
				observed.push(event.payload);
				return { ...(event.payload as Record<string, unknown>), service_tier: "priority" };
			});
		};
		const config = {
			modelOverrides: {
				"gpt-6-luna": {
					headers: { "X-Luna": "from-override" },
					samplingParams: {
						model: "wrong-sampling-model",
						access_programs: { cyber: "standard", other: "keep" },
						top_p: 0.8,
					},
				},
			},
		};
		const { runtime, dir, createSession } = await setup({ config, extension });
		const session = await createSession(
			SessionManager.create(dir, join(dir, "sessions")),
			runtime.getModel("openai", ALIAS)! as Model<"openai-responses">,
		);
		await session.prompt("compose");
		expect(observed).toHaveLength(1);
		expect(observed[0]).toMatchObject({
			model: "gpt-6-luna",
			top_p: 0.8,
			access_programs: { cyber: "daybreak_blue", other: "keep" },
		});
		expect(requests[0].body).toMatchObject({
			model: "gpt-6-luna",
			top_p: 0.8,
			access_programs: { cyber: "daybreak_blue", other: "keep" },
			service_tier: "priority",
		});
		expect(requests[0].headers.get("x-luna")).toBe("from-override");
	});

	it("applies alias-specific model and header overrides after effective Luna overrides", async () => {
		const requests = captureRequests();
		const { runtime } = await setup({
			remote: { ...luna, contextWindow: 400_000 },
			config: {
				modelOverrides: {
					"gpt-6-luna": {
						contextWindow: 335_000,
						headers: { "X-Shared": "luna", "X-Luna": "inherited" },
						samplingParams: { top_p: 0.7, temperature: 0.5 },
					},
					[ALIAS]: {
						contextWindow: 222_000,
						maxTokens: 8_000,
						headers: { "x-shared": "blue", "X-Blue": "alias" },
						samplingParams: { top_p: 0.9 },
					},
				},
			},
		});
		const alias = runtime.getModel("openai", ALIAS)!;
		expect(alias).toMatchObject({
			contextWindow: 222_000,
			maxTokens: 8_000,
			samplingParams: { top_p: 0.9, temperature: 0.5 },
		});
		expect(runtime.getModel("openai", "gpt-6-luna")?.contextWindow).toBe(335_000);
		const result = await runtime.streamSimple(alias, { messages: [] }).result();
		expect(result.stopReason).toBe("stop");
		expect(requests[0].body).toMatchObject({ top_p: 0.9, temperature: 0.5 });
		expect(requests[0].headers.get("x-luna")).toBe("inherited");
		expect(requests[0].headers.get("x-shared")).toBe("blue");
		expect(requests[0].headers.get("x-blue")).toBe("alias");
		const legacyHeaders = runtime.getCompatibilityRequestConfig(alias).headers!;
		expect(Object.entries(legacyHeaders).filter(([name]) => name.toLowerCase() === "x-shared")).toEqual([
			["x-shared", "blue"],
		]);
	});

	it("does not resolve Luna header values shadowed by alias-specific headers", async () => {
		const requests = captureRequests();
		const { runtime } = await setup({
			config: {
				modelOverrides: {
					"gpt-6-luna": {
						headers: {
							"X-Shadow-Env": "$PI_DAYBREAK_TEST_MISSING_ENV",
							"X-Shadow-Command": "!false",
							"X-Inherited": "luna",
						},
					},
					[ALIAS]: { headers: { "x-shadow-env": "blue-env", "x-shadow-command": "blue-command" } },
				},
			},
		});
		const alias = runtime.getModel("openai", ALIAS)!;
		const legacyHeaders = runtime.getCompatibilityRequestConfig(alias).headers!;
		expect(legacyHeaders).toMatchObject({ "x-shadow-env": "blue-env", "x-shadow-command": "blue-command" });
		expect((await runtime.getAuth(alias))?.auth.headers).toMatchObject({
			"x-shadow-env": "blue-env",
			"x-shadow-command": "blue-command",
			"X-Inherited": "luna",
		});
		const result = await runtime.streamSimple(alias, { messages: [] }).result();
		expect(result.stopReason).toBe("stop");
		expect(requests[0].headers.get("x-shadow-env")).toBe("blue-env");
		expect(requests[0].headers.get("x-shadow-command")).toBe("blue-command");
		await expect(runtime.getAuth(runtime.getModel("openai", "gpt-6-luna")!)).rejects.toThrow(
			"PI_DAYBREAK_TEST_MISSING_ENV",
		);
	});

	it("uses native Daybreak serialization from public summary helpers without changing custom streams", async () => {
		const requests = captureRequests();
		const { runtime, dir } = await setup();
		const alias = runtime.getModel("openai", ALIAS)!;
		const ordinary = runtime.getModel("openai", "gpt-6-luna")!;
		const message = { role: "user" as const, content: "summarize this", timestamp: Date.now() };
		const manager = SessionManager.inMemory(dir);
		manager.appendMessage(message);
		expect(await generateSummary([message], alias, undefined, "sk-fake")).toBe("ok");
		const branch = await generateBranchSummary(manager.getEntries(), {
			model: alias,
			apiKey: "sk-fake",
			signal: new AbortController().signal,
		});
		expect(branch.summary).toContain("ok");
		expect(await generateSummary([message], ordinary, undefined, "sk-fake")).toBe("ok");
		const custom = vi.fn<StreamFn>((model, context, options) =>
			runtime.streamSimple(model, context, {
				...options,
				onPayload: (payload) => ({ ...(payload as Record<string, unknown>), service_tier: "priority" }),
			}),
		);
		expect(
			await generateSummary(
				[message],
				alias,
				undefined,
				"sk-fake",
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				custom,
			),
		).toBe("ok");
		expect(custom).toHaveBeenCalledOnce();
		expect(custom.mock.calls[0][0]).toBe(alias);
		expect(custom.mock.calls[0][2]?.onPayload).toBeUndefined();
		expect(
			await generateSummary(
				[message],
				alias,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				{ OPENAI_API_KEY: "sk-environment" },
			),
		).toBe("ok");
		await expect(
			generateSummary([message], { ...alias, baseUrl: "https://gateway.invalid/v1" }, undefined, "sk-fake"),
		).rejects.toThrow("native OpenAI Responses endpoint");
		expect(requests.map(({ body }) => [body.model, body.access_programs, body.service_tier])).toEqual([
			["gpt-6-luna", { cyber: "daybreak_blue" }, undefined],
			["gpt-6-luna", { cyber: "daybreak_blue" }, undefined],
			["gpt-6-luna", undefined, undefined],
			["gpt-6-luna", { cyber: "daybreak_blue" }, "priority"],
			["gpt-6-luna", { cyber: "daybreak_blue" }, undefined],
		]);
		expect(requests[4].headers.get("authorization")).toBe("Bearer sk-environment");
	});

	it("keeps the alias unavailable when Radius replaces OpenAI despite a cached native Luna", async () => {
		const requests = captureRequests();
		const native = await setup();
		const staleAlias = native.runtime.getModel("openai", ALIAS)!;
		const radius = await setup({
			credential: oauth,
			remote: luna,
			config: { oauth: "radius", baseUrl: "https://gateway.invalid/v1" },
		});
		expect(radius.runtime.getModel("openai", "gpt-6-luna")?.baseUrl).toBe("https://api.openai.com/v1");
		expect(radius.runtime.getModel("openai", ALIAS)).toBeUndefined();
		const result = await radius.runtime.streamSimple(staleAlias, { messages: [] }).result();
		expect(result.stopReason).toBe("error");
		expect(requests).toHaveLength(0);
	});

	it("does not give a stale SDK alias new credentials after the provider changes to Radius", async () => {
		const requests = captureRequests();
		const { runtime, store, auth, dir } = await setup();
		const alias = runtime.getModel("openai", ALIAS)!;
		const registry = new ModelRegistry(runtime);
		const currentAuth = await registry.getApiKeyAndHeaders(alias);
		if (!currentAuth.ok) throw new Error(currentAuth.error);
		const currentHeaders: Record<string, string> = {};
		for (const [name, value] of Object.entries(currentAuth.headers ?? {})) {
			if (value !== null) currentHeaders[name] = value;
		}
		await generateSummary(
			[{ role: "user", content: "summarize", timestamp: Date.now() }],
			alias,
			undefined,
			currentAuth.apiKey,
			currentHeaders,
		);
		expect(requests[0].body).toMatchObject({ model: "gpt-6-luna", access_programs: { cyber: "daybreak_blue" } });
		requests.length = 0;
		await store.write("openai", { models: [luna], lastModified: Date.now() + 86_400_000 });
		await auth.modify("openai", async () => ({ ...oauth, access: "fake-radius-secret" }));
		writeFileSync(
			join(dir, "models.json"),
			JSON.stringify({ providers: { openai: { oauth: "radius", baseUrl: "https://gateway.invalid/v1" } } }),
		);
		await runtime.refresh({ providers: ["openai"], allowNetwork: false });
		expect(runtime.getModel("openai", ALIAS)).toBeUndefined();
		expect(await registry.getApiKeyAndHeaders(alias)).toMatchObject({
			ok: false,
			error: expect.stringContaining("native OpenAI Responses endpoint"),
		});
		const result = await runtime.streamSimple(alias, { messages: [] }).result();
		expect(result.stopReason).toBe("error");
		expect(requests).toHaveLength(0);
	});

	it("allows a trailing slash while preserving native ChatGPT subscription request rules", async () => {
		const requests = captureRequests();
		const { runtime } = await setup({ credential: oauth, config: { baseUrl: "https://api.openai.com/v1/" } });
		const alias = runtime.getModel("openai", ALIAS)!;
		expect(alias).toBeDefined();
		const result = await runtime.streamSimple(alias, { messages: [] }, { maxTokens: 100, temperature: 0.5 }).result();
		expect(result.stopReason).toBe("stop");
		expect(requests[0].url).toBe("https://api.openai.com/v1/responses");
		expect(requests[0].body).toMatchObject({ model: "gpt-6-luna", access_programs: { cyber: "daybreak_blue" } });
		expect(requests[0].body).not.toHaveProperty("max_output_tokens");
		expect(requests[0].body).not.toHaveProperty("temperature");
	});

	it("keeps native Responses when an extension replaces only OpenAI completions", async () => {
		const requests = captureRequests();
		const { runtime } = await setup();
		const replacement = vi.fn(() => {
			throw new Error("completions replacement should not receive Responses");
		});
		runtime.registerProvider("openai", {
			api: "openai-completions",
			streamSimple: replacement,
			models: [luna],
		});
		const alias = runtime.getModel("openai", ALIAS)!;
		expect(alias).toBeDefined();
		const result = await runtime.streamSimple(alias, { messages: [] }).result();
		expect(result.stopReason).toBe("stop");
		expect(replacement).not.toHaveBeenCalled();
		expect(requests[0].body).toMatchObject({ model: "gpt-6-luna", access_programs: { cyber: "daybreak_blue" } });
	});

	it("applies the alias to direct stream calls before their payload callback", async () => {
		const requests = captureRequests();
		const { runtime } = await setup();
		const alias = runtime.getModel("openai", ALIAS)! as Model<"openai-responses">;
		const seen: unknown[] = [];
		const result = await runtime
			.stream(
				alias,
				{ messages: [] },
				{
					onPayload: (payload) => {
						seen.push(payload);
						return { ...(payload as Record<string, unknown>), service_tier: "priority" };
					},
				},
			)
			.result();
		expect(result).toMatchObject({ model: ALIAS, stopReason: "stop" });
		expect(seen[0]).toMatchObject({ model: "gpt-6-luna", access_programs: { cyber: "daybreak_blue" } });
		expect(requests[0].body).toMatchObject({ model: "gpt-6-luna", service_tier: "priority" });
	});

	it("applies the alias to a scheduled cache-warming request", async () => {
		const requests = captureRequests();
		const forceWarm: ExtensionFactory = (pi) => {
			pi.on("cache_warming_decision", () => ({ action: "warm" }));
		};
		const { runtime, dir, createSession } = await setup({
			remote: { ...luna, promptCache: { short: 20 } },
			warming: true,
			extension: forceWarm,
		});
		const session = await createSession(SessionManager.create(dir, join(dir, "sessions")));
		await session.setModel(runtime.getModel("openai", ALIAS)!);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		await session.prompt("seed the cache");
		expect(session.cacheWarmingStatus, JSON.stringify(session.cacheWarmingStatus)).toMatchObject({
			state: "scheduled",
		});
		await vi.advanceTimersByTimeAsync(session.cacheWarmingStatus!.nextWarmAt! - Date.now());
		await vi.waitFor(() => expect(requests).toHaveLength(2), { timeout: 1000, interval: 10 });
		for (const { body } of requests) {
			expect(body).toMatchObject({ model: "gpt-6-luna", access_programs: { cyber: "daybreak_blue" } });
		}
	});

	it("does not retry a rejected Daybreak request", async () => {
		let requests = 0;
		vi.stubGlobal("fetch", async () => {
			requests++;
			return Response.json(
				{ error: { code: "access_program_not_enabled", message: "Not enabled" } },
				{ status: 403 },
			);
		});
		const { runtime, dir, createSession } = await setup();
		const session = await createSession(SessionManager.create(dir, join(dir, "sessions")));
		await session.setModel(runtime.getModel("openai", ALIAS)!);
		await session.prompt("refused");
		expect(requests).toBe(1);
		expect(session.messages.findLast((message) => message.role === "assistant")?.stopReason).toBe("error");
		expect(session.model?.id).toBe(ALIAS);
	});

	it("resumes the logical alias and applies it to real branch and compaction summaries without broadening hooks", async () => {
		const requests = captureRequests();
		let foregroundHooks = 0;
		const extension: ExtensionFactory = (pi) => {
			pi.on("before_provider_request", (event) => {
				foregroundHooks++;
				return { ...(event.payload as Record<string, unknown>), service_tier: "priority" };
			});
		};
		const { runtime, dir, createSession } = await setup({ extension });
		const manager = SessionManager.create(dir, join(dir, "sessions"));
		const session = await createSession(manager);
		await session.setModel(runtime.getModel("openai", ALIAS)!);
		await session.prompt(`first ${"a".repeat(300)}`);
		const oldLeaf = manager.getLeafId()!;
		await session.prompt(`second ${"b".repeat(300)}`);
		await session.navigateTree(oldLeaf, { summarize: true });
		expect(requests.at(-1)?.body).toMatchObject({ model: "gpt-6-luna", access_programs: { cyber: "daybreak_blue" } });
		expect(requests.at(-1)?.body).not.toHaveProperty("service_tier");
		await session.prompt(`third ${"c".repeat(300)}`);
		const before = requests.length;
		await session.compact();
		expect(requests.length).toBeGreaterThan(before);
		expect(requests.at(-1)?.body).toMatchObject({ model: "gpt-6-luna", access_programs: { cyber: "daybreak_blue" } });
		expect(requests.at(-1)?.body).not.toHaveProperty("service_tier");
		expect(foregroundHooks).toBe(3);
		const file = manager.getSessionFile()!;
		session.dispose();
		const resumed = await createSession(SessionManager.open(file));
		expect(resumed.model?.id).toBe(ALIAS);
		await resumed.prompt("resumed");
		expect(requests.at(-1)?.body).toMatchObject({ model: "gpt-6-luna", access_programs: { cyber: "daybreak_blue" } });
	});

	it("hides the alias for non-native routes and fails closed if auth changes its endpoint", async () => {
		const requests = captureRequests();
		const { runtime } = await setup({ credential: null });
		const alias = runtime.getModel("openai", ALIAS)!;
		runtime.registerProviderAuthFallback("openai", {
			check: async () => ({ type: "api_key", source: "test" }),
			resolve: async () => ({
				auth: { apiKey: "fake-subscription-token", baseUrl: "https://gateway.invalid/v1" },
				source: "test",
			}),
		});
		expect(await new ModelRegistry(runtime).getApiKeyAndHeaders(alias)).toMatchObject({
			ok: false,
			error: expect.stringContaining("native OpenAI Responses endpoint"),
		});
		const result = await runtime.streamSimple(alias, { messages: [] }).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("native OpenAI Responses endpoint");
		expect(requests).toHaveLength(0);
		const proxied = await setup({ config: { baseUrl: "https://gateway.invalid/v1" } });
		expect(proxied.runtime.getModel("openai", ALIAS)).toBeUndefined();
		expect(proxied.runtime.getModel("openai", "gpt-6-luna")?.baseUrl).toBe("https://gateway.invalid/v1");
		const hidden = await setup({ config: { modelOverrides: { "gpt-6-luna": { hidden: true } } } });
		expect(hidden.runtime.getModel("openai", ALIAS)).toBeUndefined();
		const hiddenAlias = await setup({ config: { modelOverrides: { [ALIAS]: { hidden: true } } } });
		expect(hiddenAlias.runtime.getModel("openai", ALIAS)).toBeUndefined();
	});

	it("does not inject Daybreak into an unrelated provider using the same local id", async () => {
		const requests = captureRequests();
		const { runtime } = await setup();
		runtime.registerProvider("gateway", {
			api: "openai-responses",
			baseUrl: "https://gateway.invalid/v1",
			apiKey: "fake",
			models: [{ ...luna, id: ALIAS, baseUrl: "https://gateway.invalid/v1" }],
			streamSimple: (model, context, options) => openaiStream(model as Model<"openai-responses">, context, options),
		});
		const model = runtime.getModel("gateway", ALIAS)!;
		const result = await runtime.streamSimple(model, { messages: [] }).result();
		expect(result.stopReason).toBe("stop");
		expect(requests[0].url).toBe("https://gateway.invalid/v1/responses");
		expect(requests[0].body).toMatchObject({ model: ALIAS });
		expect(requests[0].body).not.toHaveProperty("access_programs");
	});

	it("composes with provider model registrations but does not intercept replacement transports", async () => {
		const { runtime } = await setup();
		runtime.registerProvider("openai", { models: [{ ...luna, contextWindow: 444_000 }] });
		expect(runtime.getModel("openai", ALIAS)?.contextWindow).toBe(444_000);
		const alias = runtime.getModel("openai", ALIAS)!;
		const replacement = vi.fn(() => {
			throw new Error("replacement transport called");
		});
		runtime.registerProvider("openai", { api: "openai-responses", streamSimple: replacement });
		expect(runtime.getModel("openai", ALIAS)).toBeUndefined();
		const result = await runtime.streamSimple(alias, { messages: [] }).result();
		expect(result.stopReason).toBe("error");
		expect(replacement).not.toHaveBeenCalled();
	});
});
