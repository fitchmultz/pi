import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { extractPromptProgress } from "../src/core/prompt-progress.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createLlamaProvider } from "../src/extensions/llama/provider.ts";
import { formatPromptProgressMessage } from "../src/modes/interactive/components/status-indicator.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const cleanups: Array<() => Promise<void>> = [];

beforeAll(() => {
	initTheme("dark");
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) {
		await cleanup();
	}
});

describe("prompt_progress prefill status", () => {
	test("extracts valid prompt_progress payloads and rejects malformed chunks", () => {
		expect(extractPromptProgress(null)).toBeUndefined();
		expect(extractPromptProgress({})).toBeUndefined();
		expect(
			extractPromptProgress({ prompt_progress: { total: 0, cache: 0, processed: 0, time_ms: 0 } }),
		).toBeUndefined();
		expect(
			extractPromptProgress({ prompt_progress: { total: 100, cache: -1, processed: 10, time_ms: 500 } }),
		).toBeUndefined();

		expect(
			extractPromptProgress({
				choices: [],
				prompt_progress: { total: 186426, cache: 100000, processed: 116384, time_ms: 81920 },
			}),
		).toEqual({
			total: 186426,
			cache: 100000,
			processed: 116384,
			timeMs: 81920,
		});
	});

	test("computes rate and ETA from newly evaluated tokens beyond cached prefix", () => {
		expect(
			formatPromptProgressMessage({
				total: 186426,
				cache: 100000,
				processed: 100000,
				timeMs: 0,
			}),
		).toBe("Prefilling 100k/186k (53%)");

		// 10,000 newly computed tokens in 50s => 200 tok/s; 70,000 remaining => 350s (5m 50s).
		expect(
			formatPromptProgressMessage({
				total: 180000,
				cache: 100000,
				processed: 110000,
				timeMs: 50000,
			}),
		).toBe("Prefilling 110k/180k (61% · 200 tok/s · ~5m 50s left)");

		expect(
			formatPromptProgressMessage({
				total: 180000,
				cache: 100000,
				processed: 180000,
				timeMs: 400000,
			}),
		).toBeUndefined();
	});

	test("enables supportsPromptProgress on built-in llama.cpp catalog models", () => {
		const controller = createLlamaProvider();
		controller.setCatalog(
			[
				{
					id: "qwen3.8-flash",
					status: { value: "loaded" },
				},
			],
			"http://127.0.0.1:8091",
		);
		expect(controller.provider.getModels()[0]?.compat?.supportsPromptProgress).toBe(true);
	});

	test("sends return_progress: true and updates InteractiveMode working status live until decode starts", async () => {
		let capturedBody: Record<string, unknown> | undefined;
		let sseResponse: http.ServerResponse | undefined;
		let resolveRequestReceived!: () => void;
		const requestReceived = new Promise<void>((resolve) => {
			resolveRequestReceived = resolve;
		});

		const server = http.createServer((req, res) => {
			let body = "";
			req.setEncoding("utf8");
			req.on("data", (chunk) => {
				body += chunk;
			});
			req.on("end", () => {
				capturedBody = JSON.parse(body) as Record<string, unknown>;
				res.writeHead(200, {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
				});
				sseResponse = res;
				resolveRequestReceived();
			});
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		cleanups.push(
			() =>
				new Promise<void>((resolve) => {
					server.close(() => resolve());
				}),
		);
		const { port } = server.address() as AddressInfo;

		const tempDir = mkdtempSync(join(tmpdir(), "pi-prompt-progress-"));
		const model: Model<"openai-completions"> = {
			id: "deepseek-v4.1-flash",
			name: "DeepSeek V4.1 Flash",
			api: "openai-completions",
			provider: "local-maya",
			baseUrl: `http://127.0.0.1:${port}/v1`,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 524288,
			maxTokens: 32768,
			compat: {
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsReasoningEffort: false,
				supportsUsageInStreaming: true,
				supportsPromptProgress: true,
				maxTokensField: "max_tokens",
			},
		};

		let setWorkingMessageHook: ((msg?: string) => void) | undefined;
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const settingsManager = SettingsManager.inMemory({
				quietStartup: true,
				cacheWarming: "off",
			});
			const services = await createAgentSessionServices({
				cwd,
				agentDir: tempDir,
				settingsManager,
				resourceLoaderOptions: {
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
					extensionFactories: [
						(pi) => {
							pi.on("session_start", async (_event, ctx) => {
								setWorkingMessageHook = (msg) => ctx.ui.setWorkingMessage(msg);
							});
						},
					],
				},
			});
			services.modelRuntime.registerProvider("local-maya", {
				baseUrl: model.baseUrl,
				apiKey: "ds4-local",
				api: "openai-completions",
				models: [
					{
						id: model.id,
						name: model.name,
						reasoning: false,
						input: ["text"],
						cost: model.cost,
						contextWindow: model.contextWindow,
						maxTokens: model.maxTokens,
						compat: model.compat,
					},
				],
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model,
					tools: [],
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};

		const runtimeHost = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(tempDir),
		});
		const terminal = new VirtualTerminal(120, 30);
		const mode = new InteractiveMode(runtimeHost, { terminal, tuiMode: "regular" });
		cleanups.push(async () => {
			mode.stop();
			await runtimeHost.dispose();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		await mode.init();
		await terminal.waitForRender();

		const promptPromise = runtimeHost.session.prompt("Continue investigation");
		await requestReceived;
		expect(capturedBody?.return_progress).toBe(true);

		sseResponse!.write(
			`data: ${JSON.stringify({
				id: "chatcmpl-1",
				object: "chat.completion.chunk",
				created: 1,
				model: model.id,
				choices: [],
				prompt_progress: { total: 180000, cache: 100000, processed: 110000, time_ms: 50000 },
			})}\n\n`,
		);

		await vi.waitFor(async () => {
			await terminal.flush();
			expect(terminal.getViewport().join("\n")).toContain("Prefilling 110k/180k (61% · 200 tok/s · ~5m 50s left)");
		});

		// Explicit extension setWorkingMessage takes precedence while set, and falls back to prefill when cleared.
		setWorkingMessageHook?.("Custom extension status");
		await terminal.waitForRender();
		expect(terminal.getViewport().join("\n")).toContain("Custom extension status");

		setWorkingMessageHook?.(undefined);
		await terminal.waitForRender();
		expect(terminal.getViewport().join("\n")).toContain("Prefilling 110k/180k (61% · 200 tok/s · ~5m 50s left)");

		// First assistant output delta immediately reverts the status indicator from Prefilling back to Working.
		sseResponse!.write(
			`data: ${JSON.stringify({
				id: "chatcmpl-1",
				object: "chat.completion.chunk",
				created: 1,
				model: model.id,
				choices: [{ index: 0, delta: { role: "assistant", content: "All good" }, finish_reason: null }],
			})}\n\n`,
		);
		await vi.waitFor(async () => {
			await terminal.flush();
			const viewport = terminal.getViewport().join("\n");
			expect(viewport).not.toContain("Prefilling");
			expect(viewport).toContain("Working");
		});

		sseResponse!.write(
			`data: ${JSON.stringify({
				id: "chatcmpl-1",
				object: "chat.completion.chunk",
				created: 1,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 180000, completion_tokens: 2, total_tokens: 180002 },
			})}\n\ndata: [DONE]\n\n`,
		);
		sseResponse!.end();
		await promptPromise;
	});
});
