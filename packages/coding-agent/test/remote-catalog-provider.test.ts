import {
	createModels,
	createProvider,
	type ImageModel,
	InMemoryCredentialStore,
	InMemoryModelsStore,
	type Model,
	type ModelsPublication,
	type Provider,
	type RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VERSION } from "../src/config.ts";
import {
	type PersonalizeCatalog,
	REMOTE_CATALOG_MODEL_TYPES,
	withPersonalizedCatalog,
	withRemoteCatalog,
} from "../src/core/remote-catalog-provider.ts";

const neverAbortedSignal = new AbortController().signal;

function model(id: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "test-provider",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

function builtinProvider(): Provider {
	return createProvider({
		id: "test-provider",
		auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
		models: [model("static")],
		api: {
			stream: () => {
				throw new Error("not used");
			},
			streamSimple: () => {
				throw new Error("not used");
			},
		},
	});
}

function testProvider(localGeneratedAt?: number) {
	return withRemoteCatalog(builtinProvider(), "https://pi.dev", localGeneratedAt);
}

async function refreshProvider(
	provider: Provider,
	store: InMemoryModelsStore,
	overrides: Partial<Pick<RefreshModelsContext, "allowNetwork" | "force" | "signal">> = {},
): Promise<void> {
	const publish = async (publication: ModelsPublication): Promise<boolean> => {
		if (publication.persist === null) await store.delete(provider.id);
		else if (publication.persist !== undefined) await store.write(provider.id, publication.persist);
		publication.update?.();
		return true;
	};
	await provider.refreshModels?.({
		credential: { type: "api_key" },
		stored: await store.read(provider.id),
		publish,
		allowNetwork: overrides.allowNetwork ?? true,
		force: overrides.force,
		signal: overrides.signal ?? neverAbortedSignal,
	});
}

afterEach(() => vi.restoreAllMocks());

describe("remote catalog provider", () => {
	// The last column is the five-minute cache-write rate: https://platform.kimi.ai/docs/pricing/chat.
	it.each([
		["kimi-coding", "k3", "https://api.kimi.com/coding/v1", 3],
		["kimi-coding", "k3-256k", "https://api.kimi.com/coding/v1", 3],
		["kimi-coding", "k3.1-pro", "https://api.kimi.com/coding/v1", 2],
		["kimi-coding", "k3.1-pro-highspeed", "https://api.kimi.com/coding/v1", 4],
		["moonshotai", "kimi-k3", "https://api.moonshot.ai/v1", 3],
		["moonshotai", "kimi-k3.1-pro", "https://api.moonshot.ai/v1", 2],
		["moonshotai", "kimi-k3.1-pro-highspeed", "https://api.moonshot.ai/v1", 4],
		["moonshotai-cn", "kimi-k3", "https://api.moonshot.cn/v1", 3],
	])(
		"preserves the Kimi K3 five-minute cacheWrite rate on fetched and restored %s/%s OpenAI catalogs",
		async (providerId, id, baseUrl, rate) => {
			const baseline: Model<"openai-completions"> = {
				...model(id),
				provider: providerId,
				baseUrl,
				// Kimi bills five-minute cache writes at the input rate.
				cost: { input: rate, output: 15, cacheRead: 0.3, cacheWrite: rate },
			};
			const remote = [{ ...baseline, name: `Published ${id}`, cost: { ...baseline.cost, cacheWrite: 0 } }];
			vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(JSON.stringify(remote), { headers: { "last-modified": "Thu, 15 Oct 2026 00:00:00 GMT" } }),
			);
			const makeProvider = () =>
				withRemoteCatalog(
					createProvider({
						id: providerId,
						auth: { apiKey: { name: "Offline", resolve: async () => ({ auth: {} }) } },
						models: [baseline],
						api: {
							stream: () => {
								throw new Error("unused");
							},
							streamSimple: () => {
								throw new Error("unused");
							},
						},
					}),
					"https://pi.dev",
					0,
				);
			const store = new InMemoryModelsStore();
			const provider = makeProvider();
			await refreshProvider(provider, store);
			expect(provider.getModels()[0]?.cost.cacheWrite).toBe(rate);
			const restored = makeProvider();
			await refreshProvider(restored, store, { allowNetwork: false });
			expect(restored.getModels()[0]?.cost.cacheWrite).toBe(rate);
		},
	);

	it("normalizes Google limits and selects Interactions for Neon on fetched and restored overlays", async () => {
		const baseline: Model<"google-generative-ai"> = {
			...model("gemini-4-carbon"),
			api: "google-generative-ai",
			provider: "google",
			baseUrl: "https://generativelanguage.googleapis.com/v1beta",
			maxTokens: 65536,
			inputLimits: { maxRequestBytes: 100 * 1024 * 1024 },
		};
		const remote = [
			{
				...baseline,
				name: "Published Gemini 4 Carbon",
				maxTokens: 32768,
				inputLimits: { maxRequestBytes: 20 * 1024 * 1024 },
				promptCache: undefined,
			},
			{ ...baseline, id: "gemini-4-neon", name: "Published Gemini 4 Neon" },
		];
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify(remote), { headers: { "last-modified": "Thu, 15 Oct 2026 00:00:00 GMT" } }),
		);
		const makeProvider = () => withRemoteCatalog(googleProvider(), "https://pi.dev", 0);
		const store = new InMemoryModelsStore();
		const provider = makeProvider();
		await refreshProvider(provider, store);
		const restored = makeProvider();
		await refreshProvider(restored, store, { allowNetwork: false });
		for (const candidate of [provider, restored]) {
			const models = candidate.getModels();
			expect(models.find((model) => model.id === "gemini-4-carbon")).toMatchObject({
				name: "Published Gemini 4 Carbon",
				api: "google-generative-ai",
				maxTokens: 65536,
				inputLimits: { maxRequestBytes: 100 * 1024 * 1024 },
				promptCache: { short: 75 },
			});
			expect(models.find((model) => model.id === "gemini-4-neon")).toMatchObject({
				name: "Published Gemini 4 Neon",
				api: "google-interactions",
			});
		}
	});

	it("parses keyed catalogs, sends version headers, observes the refresh TTL, and supports forced refreshes", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
			async () =>
				new Response(JSON.stringify({ dynamic: model("dynamic") }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		const provider = testProvider();
		const store = new InMemoryModelsStore();
		await refreshProvider(provider, store);
		await refreshProvider(provider, store);
		await refreshProvider(provider, store, { force: true });

		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "dynamic"]);
		expect((await store.read(provider.id))?.models.map((entry) => entry.id)).toEqual(["dynamic"]);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(fetchSpy.mock.calls[0]?.[1]?.headers).toMatchObject({
			"User-Agent": expect.stringContaining(`pi/${VERSION}`),
		});
		const requested = new URL(String(fetchSpy.mock.calls[0]?.[0]));
		expect(requested.pathname).toBe("/api/models/providers/test-provider");
		expect(requested.searchParams.get("types")).toBe(REMOTE_CATALOG_MODEL_TYPES.join(","));
	});

	it("overlays image and classifier models and drops unknown model types", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(
			async () =>
				new Response(
					JSON.stringify({
						chat: { ...model("chat"), type: "chat" },
						flux: {
							type: "image",
							id: "flux",
							name: "FLUX",
							api: "openrouter-images",
							provider: "test-provider",
							baseUrl: "https://example.test/v1",
							input: ["text"],
							output: ["image"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						},
						jev: {
							type: "classifier",
							id: "jev",
							name: "Jev",
							api: "typesafe-system-one",
							provider: "test-provider",
							baseUrl: "https://example.test/v1",
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 64000,
						},
						clip: { ...model("clip"), type: "video" },
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);
		const provider = testProvider();
		const store = new InMemoryModelsStore();
		await refreshProvider(provider, store);

		const models = createModels({ modelsStore: store });
		models.setProvider(provider);
		expect(models.getAllModels("test-provider").map((entry) => entry.id)).toEqual(["static", "chat", "flux", "jev"]);
		expect(models.getModelOfType("image", "test-provider", "flux")?.type).toBe("image");
		expect(models.getModelOfType("classifier", "test-provider", "jev")?.type).toBe("classifier");
		expect(models.getModel("test-provider", "flux")).toBeUndefined();
		const stored = await store.read(provider.id);
		expect(stored?.models.map((entry) => entry.id)).toEqual(["chat", "flux", "jev"]);
	});

	it("prefers the newer of the generated and remote catalogs", async () => {
		const localGeneratedAt = Date.parse("2026-07-23T10:00:00.000Z");
		const newerHeader = new Date(localGeneratedAt + 60_000).toUTCString();
		const responses = [
			new Response(JSON.stringify({ old: model("old") }), {
				headers: { "last-modified": new Date(localGeneratedAt - 60_000).toUTCString() },
			}),
			new Response(JSON.stringify({ newer: model("newer") }), {
				headers: { "last-modified": newerHeader },
			}),
		];
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => responses.shift() as Response);
		const provider = testProvider(localGeneratedAt);
		const store = new InMemoryModelsStore();

		await refreshProvider(provider, store);
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static"]);

		await refreshProvider(provider, store, { force: true });
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "newer"]);
		expect(await store.read(provider.id)).toMatchObject({ lastModified: Date.parse(newerHeader) });
	});

	it("revalidates a stored catalog with its etag and keeps the overlay on 304", async () => {
		const responses = [
			new Response(JSON.stringify({ dynamic: model("dynamic") }), {
				headers: { "content-type": "application/json", etag: '"catalog-1"' },
			}),
			new Response(null, { status: 304, headers: { etag: '"catalog-1"' } }),
		];
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => responses.shift() as Response);
		const provider = testProvider();
		const store = new InMemoryModelsStore();

		await refreshProvider(provider, store);
		expect(fetchSpy.mock.calls[0]?.[1]?.headers).not.toHaveProperty("if-none-match");
		expect(await store.read(provider.id)).toMatchObject({ etag: '"catalog-1"' });

		const checkedAt = (await store.read(provider.id))?.checkedAt;
		await refreshProvider(provider, store, { force: true });

		expect(fetchSpy.mock.calls[1]?.[1]?.headers).toMatchObject({ "if-none-match": '"catalog-1"' });
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "dynamic"]);
		const stored = await store.read(provider.id);
		expect(stored?.models.map((entry) => entry.id)).toEqual(["dynamic"]);
		expect(stored?.etag).toBe('"catalog-1"');
		expect(stored?.checkedAt).toBeGreaterThanOrEqual(checkedAt ?? 0);
	});

	it("drops a stale etag when the overlay becomes unavailable", async () => {
		const responses = [
			new Response(JSON.stringify({ dynamic: model("dynamic") }), {
				headers: { "content-type": "application/json", etag: '"catalog-1"' },
			}),
			new Response("not implemented", { status: 501 }),
		];
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => responses.shift() as Response);
		const provider = testProvider();
		const store = new InMemoryModelsStore();

		await refreshProvider(provider, store);
		await refreshProvider(provider, store, { force: true });

		expect((await store.read(provider.id))?.etag).toBeUndefined();
	});

	it("keeps the etag and overlay after a transient failure", async () => {
		const responses = [
			new Response(JSON.stringify({ dynamic: model("dynamic") }), {
				headers: { "content-type": "application/json", etag: '"catalog-1"' },
			}),
			new Response("rate limited", { status: 429 }),
			new Response("rate limited", { status: 429 }),
			new Response("rate limited", { status: 429 }),
			new Response(null, { status: 304, headers: { etag: '"catalog-1"' } }),
		];
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => responses.shift() as Response);
		const provider = testProvider();
		const store = new InMemoryModelsStore();

		await refreshProvider(provider, store);
		await expect(refreshProvider(provider, store, { force: true })).rejects.toThrow(/429/);

		const stored = await store.read(provider.id);
		expect(stored?.etag).toBe('"catalog-1"');
		expect(stored?.models.map((entry) => entry.id)).toEqual(["dynamic"]);

		await refreshProvider(provider, store, { force: true });
		expect(fetchSpy.mock.calls[4]?.[1]?.headers).toMatchObject({ "if-none-match": '"catalog-1"' });
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "dynamic"]);
	});

	it("lets a newer catalog request bypass a stalled older request without stale publication", async () => {
		let calls = 0;
		let markFirstStarted: (() => void) | undefined;
		let finishFirst: ((response: Response) => void) | undefined;
		const firstStarted = new Promise<void>((resolve) => {
			markFirstStarted = resolve;
		});
		const firstResponse = new Promise<Response>((resolve) => {
			finishFirst = resolve;
		});
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			calls++;
			if (calls === 1) {
				markFirstStarted?.();
				return firstResponse;
			}
			return new Response(JSON.stringify({ newer: model("newer") }), {
				headers: { "content-type": "application/json" },
			});
		});
		const provider = testProvider();
		const store = new InMemoryModelsStore();
		const models = createModels({ modelsStore: store });
		models.setProvider(provider);

		const first = models.refresh({ providers: [provider.id], force: true });
		await firstStarted;
		const second = models.refresh({ providers: [provider.id], force: true });
		await second;
		await first;
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "newer"]);

		finishFirst?.(
			new Response(JSON.stringify({ older: model("older") }), {
				headers: { "content-type": "application/json" },
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "newer"]);
		expect((await store.read(provider.id))?.models.map((entry) => entry.id)).toEqual(["newer"]);
	});

	it("fetches the pi.dev catalog without refreshing a stale OAuth login", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
			async () =>
				new Response(JSON.stringify({ dynamic: model("dynamic") }), {
					headers: { "content-type": "application/json" },
				}),
		);
		const oauthRefresh = vi.fn(async (): Promise<never> => {
			throw new Error("invalid_grant");
		});
		const provider = withRemoteCatalog({
			...builtinProvider(),
			auth: {
				oauth: {
					name: "Test OAuth",
					login: async () => {
						throw new Error("not used");
					},
					refresh: oauthRefresh,
					toAuth: async (credential) => ({ apiKey: credential.access }),
				},
			},
		});
		const credentials = new InMemoryCredentialStore();
		await credentials.modify(provider.id, async () => ({
			type: "oauth",
			access: "expired",
			refresh: "revoked",
			expires: 0,
		}));
		const models = createModels({ credentials, modelsStore: new InMemoryModelsStore() });
		models.setProvider(provider);

		expect((await models.refresh({ force: true })).errors.size).toBe(0);
		expect(oauthRefresh).not.toHaveBeenCalled();
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "dynamic"]);
	});

	it("upgrades fetched pi.dev Z.AI GLM-5.4 completions overlays onto OpenAI Responses with fork compat", async () => {
		const remote = [
			{
				...model("glm-5.4"),
				provider: "zai",
				api: "openai-completions",
				baseUrl: "https://api.z.ai/api/coding/paas/v4",
				reasoning: true,
				input: ["text", "image"],
				compat: {
					supportsStore: false,
					supportsReasoningEffort: true,
					maxTokensField: "max_tokens",
					thinkingFormat: "zai",
					supportsStrictMode: true,
					zaiToolStream: true,
				},
			},
		];
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify(remote), { headers: { "last-modified": "Mon, 23 Nov 2026 00:00:00 GMT" } }),
		);
		const provider = withRemoteCatalog(
			createProvider({
				id: "zai",
				auth: { apiKey: { name: "Z.AI", resolve: async () => ({ auth: {} }) } },
				models: [],
				api: {
					"openai-completions": {
						stream: () => {
							throw new Error("unused");
						},
						streamSimple: () => {
							throw new Error("unused");
						},
					},
					"openai-responses": {
						stream: () => {
							throw new Error("unused");
						},
						streamSimple: () => {
							throw new Error("unused");
						},
					},
				},
			}),
			"https://pi.dev",
		);
		const store = new InMemoryModelsStore();
		await refreshProvider(provider, store);
		const resolved = provider.getModels().find((entry) => entry.id === "glm-5.4");
		expect(resolved).toMatchObject({
			id: "glm-5.4",
			provider: "zai",
			api: "openai-responses",
			baseUrl: "https://api.z.ai/api/v1",
			compat: {
				supportsDeveloperRole: true,
				supportsMidConvoSystemMessages: true,
				supportsStrictMode: true,
				supportsOpenAIGrammarTools: true,
				supportsLongCacheRetention: false,
			},
		});
		expect(resolved?.compat).not.toHaveProperty("thinkingFormat");
	});

	it("treats unimplemented pi.dev catalog routes as an unavailable overlay", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not implemented", { status: 501 }));
		const provider = testProvider();
		const store = new InMemoryModelsStore();

		await expect(refreshProvider(provider, store)).resolves.toBeUndefined();
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static"]);
		expect(await store.read(provider.id)).toMatchObject({ models: [], checkedAt: expect.any(Number) });
	});
});

describe("personalized catalog provider", () => {
	const imageModel: ImageModel<"openrouter-images"> = {
		type: "image",
		id: "image",
		name: "image",
		api: "openrouter-images",
		provider: "test-provider",
		baseUrl: "https://example.test/v1",
		input: ["text"],
		output: ["image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};

	it("keeps the saved list and saves nothing when personalization fails", async () => {
		// Saving the catalog without personalization would replace the key's list with every model.
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not found", { status: 404 }));
		const store = new InMemoryModelsStore();
		const saved = { models: [model("allowed")], checkedAt: 1 };
		await store.write("test-provider", saved);
		const personalize: PersonalizeCatalog = async () => {
			throw new Error("user models request failed");
		};
		const provider = withPersonalizedCatalog(builtinProvider(), personalize);

		await expect(refreshProvider(provider, store)).rejects.toThrow("user models request failed");
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["allowed"]);
		expect(await store.read(provider.id)).toEqual(saved);
	});

	it("restores a saved list as is, and falls back to the built-in models only when it is empty", async () => {
		const personalize: PersonalizeCatalog = async () => {
			throw new Error("not used offline");
		};
		const store = new InMemoryModelsStore();
		const provider = withPersonalizedCatalog(builtinProvider(), personalize);

		// pi versions before per-key lists stored the plain pi.dev catalog here, and saved an empty list
		// after a missing pi.dev catalog or a failed first request. Only such an entry can be empty.
		await store.write(provider.id, { models: [], checkedAt: 1 });
		await refreshProvider(provider, store, { allowNetwork: false });
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static"]);

		// A key that may use no chat models keeps its image models and shows no chat models.
		await store.write(provider.id, { models: [imageModel], checkedAt: 1 });
		await refreshProvider(provider, store, { allowNetwork: false });
		expect(provider.getModels()).toEqual([]);
		expect(provider.getAllModels?.().map((entry) => entry.id)).toEqual(["image"]);
	});
});
