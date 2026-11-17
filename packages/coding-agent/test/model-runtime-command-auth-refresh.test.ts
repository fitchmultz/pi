import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	contentText,
	createAssistantMessageEventStream,
	type FetchFunction,
	InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { clearConfigValueCache } from "../src/core/resolve-config-value.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

function toShPath(path: string): string {
	return path.replace(/\\/g, "/").replace(/"/g, '\\"');
}

function anthropicTextSseResponse(text: string): Response {
	const body = [
		`event: message_start\ndata: ${JSON.stringify({
			type: "message_start",
			message: { id: "msg_test", model: "claude-sonnet-4-5", usage: { input_tokens: 4, output_tokens: 0 } },
		})}\n`,
		`event: content_block_start\ndata: ${JSON.stringify({
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		})}\n`,
		`event: content_block_delta\ndata: ${JSON.stringify({
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text },
		})}\n`,
		`event: content_block_stop\ndata: ${JSON.stringify({
			type: "content_block_stop",
			index: 0,
		})}\n`,
		`event: message_delta\ndata: ${JSON.stringify({
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { output_tokens: 2 },
		})}\n`,
		`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n`,
	].join("\n");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function openAiResponsesSseResponse(text: string): Response {
	const events = [
		{
			type: "response.created",
			response: { id: "resp_test", status: "in_progress", output: [] },
		},
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { id: "msg_1", type: "message", role: "assistant", status: "in_progress", content: [] },
		},
		{
			type: "response.content_part.added",
			output_index: 0,
			content_index: 0,
			part: { type: "output_text", text: "" },
		},
		{
			type: "response.output_text.delta",
			output_index: 0,
			content_index: 0,
			delta: text,
		},
		{
			type: "response.output_text.done",
			output_index: 0,
			content_index: 0,
			text,
		},
		{
			type: "response.output_item.done",
			output_index: 0,
			item: {
				id: "msg_1",
				type: "message",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text }],
			},
		},
		{
			type: "response.completed",
			response: {
				id: "resp_test",
				status: "completed",
				output: [
					{
						id: "msg_1",
						type: "message",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text }],
					},
				],
				usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
			},
		},
	];
	const body = `${events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("ModelRuntime and AgentSession command credential refresh", () => {
	const tempDirs: string[] = [];

	beforeEach(() => {
		clearConfigValueCache();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		clearConfigValueCache();
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function createCommandFixture(initialKey: string): {
		dir: string;
		authPath: string;
		keyFile: string;
		counterFile: string;
		command: string;
		readCount: () => number;
	} {
		const dir = mkdtempSync(join(tmpdir(), "pi-command-auth-"));
		tempDirs.push(dir);
		const authPath = join(dir, "auth.json");
		const keyFile = join(dir, "key.txt");
		const counterFile = join(dir, "count.txt");
		writeFileSync(keyFile, initialKey);
		writeFileSync(counterFile, "0");
		const keySh = toShPath(keyFile);
		const countSh = toShPath(counterFile);
		const command = `!sh -c 'count=$(cat "${countSh}"); echo $((count + 1)) > "${countSh}"; cat "${keySh}"'`;
		return {
			dir,
			authPath,
			keyFile,
			counterFile,
			command,
			readCount: () => Number(readFileSync(counterFile, "utf-8").trim()),
		};
	}

	it("clears cached !command credentials during AgentSession.reload()", async () => {
		const fixture = createCommandFixture("sk-ant-initial");
		writeFileSync(
			fixture.authPath,
			JSON.stringify({
				anthropic: { type: "api_key", key: fixture.command },
			}),
		);

		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.create(fixture.authPath),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const countAfterStartup = fixture.readCount();
		expect((await runtime.getAuth("anthropic"))?.auth.apiKey).toBe("sk-ant-initial");
		expect(fixture.readCount()).toBe(countAfterStartup);

		const { session } = await createAgentSession({
			cwd: fixture.dir,
			agentDir: fixture.dir,
			modelRuntime: runtime,
			sessionManager: SessionManager.inMemory(fixture.dir),
			settingsManager: SettingsManager.inMemory(),
		});
		try {
			writeFileSync(fixture.keyFile, "sk-ant-rotated");
			expect((await runtime.getAuth("anthropic"))?.auth.apiKey).toBe("sk-ant-initial");

			await session.reload();

			expect((await runtime.getAuth("anthropic"))?.auth.apiKey).toBe("sk-ant-rotated");
			expect(fixture.readCount()).toBeGreaterThan(countAfterStartup);
		} finally {
			session.dispose();
		}
	});

	it("refreshes cached !command credentials on 401/403 in streamSimple and complete, without looping when unchanged", async () => {
		const fixture = createCommandFixture("cf-token-a");
		writeFileSync(
			fixture.authPath,
			JSON.stringify({
				"cloudflare-ai-gateway": {
					type: "api_key",
					key: fixture.command,
					env: {
						CLOUDFLARE_ACCOUNT_ID: "acct-test",
						CLOUDFLARE_GATEWAY_ID: "gw-test",
					},
				},
			}),
		);

		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.create(fixture.authPath),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const openaiModel = runtime.getModels("cloudflare-ai-gateway").find((entry) => entry.api === "openai-responses")!;
		const anthropicModel = runtime
			.getModels("cloudflare-ai-gateway")
			.find((entry) => entry.api === "anthropic-messages")!;
		expect(openaiModel).toBeDefined();
		expect(anthropicModel).toBeDefined();

		let activeServerToken = "cf-token-a";
		let failureStatus = 401;
		const seenTokens: string[] = [];
		const mockFetch: typeof globalThis.fetch = async (input, init) => {
			const req = new Request(input, init);
			const cfAuth = req.headers.get("cf-aig-authorization") ?? req.headers.get("authorization") ?? "";
			const token = cfAuth.replace(/^Bearer\s+/iu, "");
			seenTokens.push(token);
			if (token !== activeServerToken) {
				return new Response(JSON.stringify({ error: { message: "AiGatewayError: 2009 Unauthorized" } }), {
					status: failureStatus,
					headers: { "content-type": "application/json" },
				});
			}
			return req.url.includes("/anthropic")
				? anthropicTextSseResponse(`ok:${token}`)
				: openAiResponsesSseResponse(`ok:${token}`);
		};

		const chatContext = {
			messages: [{ role: "user" as const, content: "ping", timestamp: Date.now() }],
		};

		// Turn 1: caches cf-token-a and succeeds.
		const first = await runtime.streamSimple(openaiModel, chatContext, { fetch: mockFetch }).result();
		expect(first.stopReason).toBe("stop");
		expect(contentText(first.content)).toBe("ok:cf-token-a");
		expect(seenTokens).toEqual(["cf-token-a"]);
		const countAfterFirstTurn = fixture.readCount();

		// Rotate underlying token file to cf-token-b; cf-token-a now returns 401 AiGatewayError: 2009 Unauthorized.
		writeFileSync(fixture.keyFile, "cf-token-b");
		activeServerToken = "cf-token-b";
		seenTokens.length = 0;

		// Turn 2 (streamSimple): hits 401 with cached cf-token-a, invalidates cache, re-runs !command, retries with cf-token-b, and succeeds on the same turn.
		const second = await runtime.streamSimple(openaiModel, chatContext, { fetch: mockFetch }).result();
		expect(second.stopReason).toBe("stop");
		expect(contentText(second.content)).toBe("ok:cf-token-b");
		expect(seenTokens).toEqual(["cf-token-a", "cf-token-b"]);
		const countAfterRotation = fixture.readCount();
		expect(countAfterRotation).toBe(countAfterFirstTurn + 1);

		// Turn 3: uses cached cf-token-b without re-running the shell command.
		seenTokens.length = 0;
		const third = await runtime.streamSimple(openaiModel, chatContext, { fetch: mockFetch }).result();
		expect(third.stopReason).toBe("stop");
		expect(seenTokens).toEqual(["cf-token-b"]);
		expect(fixture.readCount()).toBe(countAfterRotation);

		// Turn 4 (complete / stream on anthropic-messages with 403): rotates cf-token-b -> cf-token-c and recovers on the same call.
		failureStatus = 403;
		writeFileSync(fixture.keyFile, "cf-token-c");
		activeServerToken = "cf-token-c";
		seenTokens.length = 0;
		const fourth = await runtime.complete(anthropicModel, chatContext, { fetch: mockFetch });
		expect(fourth.stopReason).toBe("stop");
		expect(contentText(fourth.content)).toBe("ok:cf-token-c");
		expect(seenTokens).toEqual(["cf-token-b", "cf-token-c"]);

		// Turn 5: token file NOT updated (still cf-token-c), server rejects cf-token-c with 401.
		// Must re-check command once, observe unchanged token, and surface 401 after 1 HTTP attempt (no retry loop).
		failureStatus = 401;
		activeServerToken = "cf-token-d";
		seenTokens.length = 0;
		const countBeforeUnchanged401 = fixture.readCount();
		const fifth = await runtime.streamSimple(openaiModel, chatContext, { fetch: mockFetch }).result();
		expect(fifth.stopReason).toBe("error");
		expect(fifth.errorMessage).toContain("AiGatewayError: 2009 Unauthorized");
		expect(seenTokens).toEqual(["cf-token-c"]);
		expect(fixture.readCount()).toBe(countBeforeUnchanged401 + 1);
	});

	it("refreshes cached !command credentials on 401 in classify and generateImages only when the key changes", async () => {
		const fixture = createCommandFixture("key-1");
		writeFileSync(
			fixture.authPath,
			JSON.stringify({
				typesafe: { type: "api_key", key: fixture.command },
				openrouter: { type: "api_key", key: fixture.command },
			}),
		);

		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.create(fixture.authPath),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});

		const classifier = runtime.getModelOfType("classifier", "typesafe", "jev-latest")!;
		const imageModel = runtime.getModelsOfType("image", "openrouter")[0]!;
		const classifierInput = {
			state: { text: "Looks good" },
			questions: {
				approved: {
					type: "bool" as const,
					instructions: "Approved?",
					criteria: { true: "Yes", false: "No" },
				},
			},
		};

		// Prime cache with key-1, then rotate file to key-2 and require key-2 at the HTTP boundary.
		expect((await runtime.getAuth("typesafe"))?.auth.apiKey).toBe("key-1");
		writeFileSync(fixture.keyFile, "key-2");

		const classifyAuthHeaders: string[] = [];
		const classified = await runtime.classify(classifier, classifierInput, {
			fetch: async (input, init) => {
				const auth = new Request(input, init).headers.get("authorization") ?? "";
				classifyAuthHeaders.push(auth);
				if (auth !== "Bearer key-2") {
					return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
				}
				return Response.json({ answers: { approved: { type: "noul", noul: 0.75 } } });
			},
		});
		expect(classified.stopReason).toBe("stop");
		expect(classified.answers.approved).toEqual({ type: "bool", probability: 0.75 });
		expect(classifyAuthHeaders).toEqual(["Bearer key-1", "Bearer key-2"]);

		// Rotate file to key-3 for generateImages; key-2 fails with 401 and key-3 succeeds.
		writeFileSync(fixture.keyFile, "key-3");
		const imageAuthHeaders: string[] = [];
		const generated = await runtime.generateImages(
			imageModel,
			{ input: [{ type: "text", text: "circle" }] },
			{
				fetch: async (input, init) => {
					const auth = new Request(input, init).headers.get("authorization") ?? "";
					imageAuthHeaders.push(auth);
					if (auth !== "Bearer key-3") {
						return new Response(JSON.stringify({ error: { message: "Unauthorized" } }), {
							status: 401,
							headers: { "content-type": "application/json" },
						});
					}
					return Response.json({
						id: "img_1",
						choices: [
							{
								index: 0,
								message: {
									role: "assistant",
									content: null,
									images: [{ type: "image_url", image_url: { url: "data:image/png;base64,aGk=" } }],
								},
								finish_reason: "stop",
							},
						],
					});
				},
			},
		);
		expect(generated.stopReason).toBe("stop");
		expect(generated.output).toEqual([{ type: "image", mimeType: "image/png", data: "aGk=" }]);
		expect(imageAuthHeaders).toEqual(["Bearer key-2", "Bearer key-3"]);

		// Unchanged key-3 on 401 does not hit fetch a second time.
		const unchangedCalls: string[] = [];
		const failedImage = await runtime.generateImages(
			imageModel,
			{ input: [{ type: "text", text: "circle" }] },
			{
				fetch: async (input, init) => {
					unchangedCalls.push(new Request(input, init).headers.get("authorization") ?? "");
					return new Response(JSON.stringify({ error: { message: "Unauthorized" } }), {
						status: 401,
						headers: { "content-type": "application/json" },
					});
				},
			},
		);
		expect(failedImage.stopReason).toBe("error");
		expect(unchangedCalls).toEqual(["Bearer key-3"]);
	});

	it("preserves the cached key and configured status when the !command transiently fails during a 401 refresh", async () => {
		const fixture = createCommandFixture("cf-token-a");
		writeFileSync(
			fixture.authPath,
			JSON.stringify({
				"cloudflare-ai-gateway": {
					type: "api_key",
					key: fixture.command,
					env: {
						CLOUDFLARE_ACCOUNT_ID: "acct-test",
						CLOUDFLARE_GATEWAY_ID: "gw-test",
					},
				},
			}),
		);

		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.create(fixture.authPath),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const model = runtime.getModels("cloudflare-ai-gateway").find((entry) => entry.api === "openai-responses")!;
		const chatContext = {
			messages: [{ role: "user" as const, content: "ping", timestamp: Date.now() }],
		};

		let activeServerToken = "cf-token-a";
		const seenTokens: string[] = [];
		const mockFetch: typeof globalThis.fetch = async (input, init) => {
			const req = new Request(input, init);
			const cfAuth = req.headers.get("cf-aig-authorization") ?? "";
			const token = cfAuth.replace(/^Bearer\s+/iu, "");
			seenTokens.push(token);
			if (token !== activeServerToken) {
				return new Response(JSON.stringify({ error: { message: "AiGatewayError: 2009 Unauthorized" } }), {
					status: 401,
					headers: { "content-type": "application/json" },
				});
			}
			return openAiResponsesSseResponse(`ok:${token}`);
		};

		// Turn 1: caches cf-token-a.
		const first = await runtime.streamSimple(model, chatContext, { fetch: mockFetch }).result();
		expect(first.stopReason).toBe("stop");
		expect(seenTokens).toEqual(["cf-token-a"]);

		// Server rotates to cf-token-b while secret manager transiently returns empty output.
		activeServerToken = "cf-token-b";
		writeFileSync(fixture.keyFile, "");
		seenTokens.length = 0;
		const countBeforeTransientFailure = fixture.readCount();

		const transientFail = await runtime.streamSimple(model, chatContext, { fetch: mockFetch }).result();
		expect(transientFail.stopReason).toBe("error");
		expect(transientFail.errorMessage).toContain("AiGatewayError: 2009 Unauthorized");
		expect(seenTokens).toEqual(["cf-token-a"]);
		expect(fixture.readCount()).toBe(countBeforeTransientFailure + 1);

		// Provider stays configured with cf-token-a rather than caching undefined.
		expect((await runtime.getAuth("cloudflare-ai-gateway"))?.auth.headers?.["cf-aig-authorization"]).toBe(
			"Bearer cf-token-a",
		);
		expect(runtime.hasConfiguredAuth("cloudflare-ai-gateway")).toBe(true);

		// Once secret manager recovers with cf-token-b, the next call refreshes on 401 and succeeds without /reload.
		writeFileSync(fixture.keyFile, "cf-token-b");
		seenTokens.length = 0;
		const recovered = await runtime.streamSimple(model, chatContext, { fetch: mockFetch }).result();
		expect(recovered.stopReason).toBe("stop");
		expect(contentText(recovered.content)).toBe("ok:cf-token-b");
		expect(seenTokens).toEqual(["cf-token-a", "cf-token-b"]);
	});

	it("preserves the Anthropic workload identity federation token cache across ModelRuntime.streamSimple turns", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-federation-auth-"));
		tempDirs.push(dir);
		const identityTokenFile = join(dir, "identity.jwt");
		writeFileSync(identityTokenFile, "header.payload.signature");
		const federationEnv = {
			ANTHROPIC_FEDERATION_RULE_ID: "fdrl_test",
			ANTHROPIC_ORGANIZATION_ID: "org-test",
			ANTHROPIC_IDENTITY_TOKEN_FILE: identityTokenFile,
		};

		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({}),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const model = runtime.getModels("anthropic").find((entry) => entry.api === "anthropic-messages")!;
		const chatContext = {
			messages: [{ role: "user" as const, content: "ping", timestamp: Date.now() }],
		};

		let tokenCounter = 0;
		const paths: string[] = [];
		const messageAuthHeaders: Array<string | null> = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const req = new Request(input, init);
			const path = new URL(req.url).pathname;
			paths.push(path);
			if (path === "/v1/oauth/token") {
				tokenCounter += 1;
				return Response.json({ access_token: `tok-${tokenCounter}`, expires_in: 3600 });
			}
			messageAuthHeaders.push(req.headers.get("authorization"));
			return anthropicTextSseResponse("ok");
		});

		for (let i = 0; i < 3; i++) {
			const result = await runtime.streamSimple(model, chatContext, { env: federationEnv }).result();
			expect(result.stopReason).toBe("stop");
		}

		expect(paths).toEqual(["/v1/oauth/token", "/v1/messages", "/v1/messages", "/v1/messages"]);
		expect(messageAuthHeaders).toEqual(["Bearer tok-1", "Bearer tok-1", "Bearer tok-1"]);
	});

	it("keeps options.fetch reference-identical across consecutive calls and 401 retries for !command providers", async () => {
		const fixture = createCommandFixture("cmd-key-1");
		writeFileSync(
			fixture.authPath,
			JSON.stringify({
				"custom-cmd": { type: "api_key", key: fixture.command },
			}),
		);

		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.create(fixture.authPath),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});

		const seenFetches: Array<FetchFunction | undefined> = [];
		runtime.registerProvider("custom-cmd", {
			baseUrl: "https://custom.example.test/v1",
			api: "openai-responses",
			models: [
				{
					id: "cmd-model",
					name: "Cmd Model",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 8192,
					maxTokens: 1024,
				},
			],
			streamSimple: (model, _context, options) => {
				seenFetches.push(options?.fetch);
				const stream = createAssistantMessageEventStream();
				void (async () => {
					const response = await (options?.fetch ?? globalThis.fetch)("https://custom.example.test/v1/responses", {
						headers: { authorization: `Bearer ${options?.apiKey ?? ""}` },
					});
					const usage = {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					};
					if (!response.ok) {
						const errMsg = {
							role: "assistant" as const,
							content: [],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage,
							stopReason: "error" as const,
							errorMessage: `HTTP ${response.status}`,
							timestamp: Date.now(),
						};
						stream.push({ type: "error", reason: "error", error: errMsg });
						stream.end(errMsg);
						return;
					}
					const text = await response.text();
					const msg = {
						role: "assistant" as const,
						content: [{ type: "text" as const, text }],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage,
						stopReason: "stop" as const,
						timestamp: Date.now(),
					};
					stream.push({ type: "done", reason: "stop", message: msg });
					stream.end(msg);
				})();
				return stream;
			},
		});

		const model = runtime.getModel("custom-cmd", "cmd-model")!;
		const chatContext = {
			messages: [{ role: "user" as const, content: "ping", timestamp: Date.now() }],
		};

		let activeKey = "cmd-key-1";
		const mockFetch: FetchFunction = async (input, init) => {
			const auth = new Request(input, init).headers.get("authorization");
			if (auth !== `Bearer ${activeKey}`) {
				return new Response("Unauthorized", { status: 401 });
			}
			return new Response(`ok:${activeKey}`, { status: 200 });
		};

		const first = await runtime.streamSimple(model, chatContext, { fetch: mockFetch }).result();
		expect(first.stopReason).toBe("stop");
		expect(contentText(first.content)).toBe("ok:cmd-key-1");

		activeKey = "cmd-key-2";
		writeFileSync(fixture.keyFile, "cmd-key-2");
		const second = await runtime.streamSimple(model, chatContext, { fetch: mockFetch }).result();
		expect(second.stopReason).toBe("stop");
		expect(contentText(second.content)).toBe("ok:cmd-key-2");

		const third = await runtime.streamSimple(model, chatContext, { fetch: mockFetch }).result();
		expect(third.stopReason).toBe("stop");
		expect(contentText(third.content)).toBe("ok:cmd-key-2");

		expect(seenFetches).toHaveLength(4);
		expect(seenFetches[0]).toBeDefined();
		expect(seenFetches[1]).toBe(seenFetches[0]);
		expect(seenFetches[2]).toBe(seenFetches[0]);
		expect(seenFetches[3]).toBe(seenFetches[0]);
	});
});
