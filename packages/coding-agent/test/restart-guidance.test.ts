import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	getCurrentSystemPrompt,
	type Model,
	type SystemMessage,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { streamSimple as codexStream } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { streamSimple as completionsStream } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as responsesStream } from "@earendil-works/pi-ai/api/openai-responses";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MANAGED_CLI_ENV, RESTART_SOCKET_ENV } from "../src/cli/restart-protocol.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import restartExtension, { createManagedRestart } from "../src/extensions/restart/index.ts";
import { createTestUiContext } from "./suite/harness.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// Vitest's fork supplies real IPC admission; the actual owner creates/cleans its native socket.
// No launcher replacement or installed runtime is involved in this source-level regression.
async function managedFixture(
	options: { sessionFile?: string; extensions?: ExtensionFactory[]; mode?: "tui" | "print" } = {},
) {
	const root = mkdtempSync(join(tmpdir(), "pi-restart-guidance-"));
	const disconnectHandlers = new Set(process.listeners("disconnect"));
	expect(process.send).toBeTypeOf("function");
	expect(process.connected).toBe(true);
	vi.stubEnv(MANAGED_CLI_ENV, "1");
	expect(createManagedRestart()).toBeDefined();
	const faux = fauxProvider();
	const sessionManager = options.sessionFile
		? SessionManager.open(options.sessionFile)
		: SessionManager.create(root, root);
	const cwd = sessionManager.getCwd();
	const settingsManager = SettingsManager.inMemory({ cacheWarming: "off" });
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: join(root, "agent"),
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: [
			(pi) => {
				pi.registerProvider("faux", {
					api: faux.api,
					baseUrl: faux.getModel().baseUrl,
					apiKey: "faux-key",
					models: faux.models,
					streamSimple: faux.provider.streamSimple,
				});
				pi.registerTool({
					name: "work",
					label: "Work",
					description: "Offline work",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "done" }], details: undefined }),
				});
			},
			...(options.extensions ?? []),
			restartExtension,
		],
	});
	await loader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir: join(root, "agent"),
		resourceLoader: loader,
		modelRuntime: await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null }),
		model: faux.getModel(),
		settingsManager,
		tools: ["work"],
		sessionManager,
	});
	const h = { session, sessionManager };
	let closed = false;
	const close = async () => {
		if (closed) return;
		closed = true;
		// Public reload emits session_shutdown; print mode prevents reopening control during cleanup.
		await h.session.bindExtensions({ mode: "print" });
		await h.session.reload();
		h.session.dispose();
		for (const handler of process.listeners("disconnect")) {
			if (!disconnectHandlers.has(handler)) process.removeListener("disconnect", handler);
		}
		// The managed owner unrefs IPC; Vitest still needs its worker channel after this fixture.
		process.channel?.ref();
	};
	cleanups.push(async () => {
		await close();
		rmSync(root, { recursive: true, force: true });
	});
	await h.session.bindExtensions({ mode: options.mode ?? "tui", uiContext: createTestUiContext() });
	await h.session.setModel(faux.getModel());
	if (options.mode !== "print") expect(process.env[RESTART_SOCKET_ENV]).toBeDefined();
	const requests: TranscriptContext[] = [];
	const response =
		(tools = false) =>
		(context: TranscriptContext) => {
			requests.push(structuredClone(context));
			return tools
				? fauxAssistantMessage([fauxToolCall("work", {}), fauxToolCall("work", {})], { stopReason: "toolUse" })
				: fauxAssistantMessage("done");
		};
	const wake = async () => {
		faux.setResponses([response(true), response()]);
		await h.session.sendCustomMessage(
			{ customType: "wake", content: "Wake receipt", display: false },
			{ triggerTurn: true },
		);
	};
	return { h, faux, requests, response, wake, close };
}

interface Payload {
	messages?: unknown[];
	input?: unknown[];
	instructions?: string;
	tools?: unknown[];
}

async function payloads(
	contexts: TranscriptContext[],
	api: "openai-completions" | "openai-responses" | "openai-codex-responses",
) {
	const model: Model<typeof api> = {
		id: api === "openai-completions" ? "glm-5.3" : "gpt-6.1-sol",
		name: "Offline serializer fixture",
		api,
		provider: api === "openai-codex-responses" ? "openai-codex" : "openai",
		baseUrl: "https://example.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 1000,
		compat:
			api === "openai-completions"
				? { supportsDeveloperRole: false }
				: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true },
	};
	const captures: Payload[] = [];
	for (const context of contexts) {
		const options = {
			apiKey: `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url")}.x`,
			onPayload(value: unknown) {
				captures.push(structuredClone(value) as Payload);
				throw new Error("offline payload captured");
			},
		};
		const result = await (api === "openai-completions"
			? completionsStream({ ...model, api }, context, options)
			: api === "openai-responses"
				? responsesStream({ ...model, api }, context, options)
				: codexStream({ ...model, api }, context, options)
		).result();
		expect(result.errorMessage).toContain("offline payload captured");
	}
	return captures;
}

async function expectStableRequests(contexts: TranscriptContext[]) {
	for (const api of ["openai-completions", "openai-responses", "openai-codex-responses"] as const) {
		const captures = await payloads(contexts, api);
		for (let i = 1; i < captures.length; i++) {
			const previous = captures[i - 1];
			const current = captures[i];
			expect(current.tools).toEqual(previous.tools);
			if (api === "openai-completions") expect(current.messages?.[0]).toEqual(previous.messages?.[0]);
			else {
				expect(current.input?.slice(0, previous.input?.length)).toEqual(previous.input);
				expect(current.instructions).toEqual(previous.instructions);
			}
		}
	}
}

function restartSection(context: TranscriptContext): string {
	const head = context.messages[0];
	expect(head?.role).toBe("system");
	if (head?.role !== "system") throw new Error("Expected system head");
	expect(head.sections?.restart).toMatch(/^<restart>\nUse \/reload[\s\S]*\n<\/restart>$/);
	return head.sections!.restart!;
}

describe("actual managed restart guidance", () => {
	it.each(["idle", "deferred"] as const)(
		"keeps the serialized head across %s wake, tools, and next user without extra hooks",
		async (delivery) => {
			let hooks = 0;
			let queued = false;
			const f = await managedFixture({
				extensions: [
					(pi) => {
						pi.on("before_agent_start", () => {
							hooks++;
						});
						pi.on("agent_settled", () => {
							if (delivery === "deferred" && !queued) {
								queued = true;
								pi.sendMessage(
									{ customType: "wake", content: "Wake receipt", display: false },
									{ triggerTurn: true },
								);
							}
						});
					},
				],
			});
			f.faux.setResponses(delivery === "deferred" ? [f.response(), f.response(true), f.response()] : [f.response()]);
			await f.h.session.prompt("Seed");
			if (delivery === "idle") await f.wake();
			await f.h.session.waitForIdle();
			expect(hooks).toBe(1);
			f.faux.setResponses([f.response()]);
			await f.h.session.prompt("Next user");
			expect(hooks).toBe(2);
			expect(f.requests).toHaveLength(4);
			for (const request of f.requests) restartSection(request);
			expect(f.h.session.messages.filter((m) => m.role === "custom" && m.customType === "wake")).toHaveLength(1);
			await expectStableRequests(f.requests);
		},
	);

	it("survives actual reload and saved-session reopen with fresh factories", async () => {
		const f = await managedFixture();
		f.faux.setResponses([f.response()]);
		await f.h.session.prompt("Seed");
		await f.h.session.reload();
		await f.wake();
		const file = f.h.sessionManager.getSessionFile()!;
		await f.close();
		let hooks = 0;
		const reopened = await managedFixture({
			sessionFile: file,
			extensions: [
				(pi) => {
					pi.on("before_agent_start", () => {
						hooks++;
					});
				},
			],
		});
		await reopened.wake();
		expect(hooks).toBe(0);
		expect(f.requests).toHaveLength(3);
		expect(reopened.requests).toHaveLength(2);
		for (const request of [...f.requests, ...reopened.requests]) restartSection(request);
		await expectStableRequests([...f.requests, ...reopened.requests]);
	});

	it("supplies guidance on a fresh custom request without claiming full base initialization", async () => {
		let hooks = 0;
		const f = await managedFixture({
			extensions: [
				(pi) => {
					pi.on("before_agent_start", () => {
						hooks++;
					});
				},
			],
		});
		await f.wake();
		expect(hooks).toBe(0);
		expect(f.requests).toHaveLength(2);
		for (const request of f.requests) restartSection(request);
		const captures = await payloads(f.requests, "openai-completions");
		// Separate native ceiling: base sections still arrive only after the fresh custom tool batch.
		expect(captures[1].messages?.[0]).not.toEqual(captures[0].messages?.[0]);
	});

	it("appends actual guidance exactly once to post-hook forced text, never persists or revives it", async () => {
		let hooks = 0;
		const f = await managedFixture({
			extensions: [
				(pi) => {
					pi.on("before_agent_start", (event) => {
						hooks++;
						if (event.prompt === "Force") event.systemPromptOptions.forceSystemPrompt = "Exact forced text.";
					});
				},
			],
		});
		f.faux.setResponses([f.response()]);
		await f.h.session.prompt("Seed");
		const guidance = restartSection(f.requests[0]).slice("<restart>\n".length, -"\n</restart>".length);
		f.faux.setResponses([f.response(true), f.response()]);
		await f.h.session.prompt("Force");
		expect(f.requests).toHaveLength(3);
		const postHook = `Exact forced text.\n\n${guidance}`;
		for (const request of f.requests.slice(1)) expect(getCurrentSystemPrompt(request.messages)).toBe(postHook);
		expect(readFileSync(f.h.sessionManager.getSessionFile()!, "utf8")).not.toContain("Exact forced text.");
		await f.wake();
		expect(hooks).toBe(2);
		expect(f.requests).toHaveLength(5);
		for (const request of f.requests.slice(3)) {
			restartSection(request);
			expect(getCurrentSystemPrompt(request.messages)).not.toContain("Exact forced text.");
		}
		const file = f.h.sessionManager.getSessionFile()!;
		await f.close();
		const reopened = await managedFixture({ sessionFile: file });
		await reopened.wake();
		expect(reopened.requests).toHaveLength(2);
		for (const request of reopened.requests) {
			restartSection(request);
			expect(getCurrentSystemPrompt(request.messages)).not.toContain("Exact forced text.");
		}
	});

	it("does not advertise managed guidance when the owner has no active TUI control", async () => {
		const f = await managedFixture({ mode: "print" });
		f.faux.setResponses([f.response()]);
		await f.h.session.prompt("Seed");
		expect(getCurrentSystemPrompt(f.requests[0].messages)).not.toContain("<restart>");
	});

	it("removes only later owned restart patches, preserving unrelated system content, sections and tool deltas", async () => {
		const added = { name: "added", description: "Additional tool", parameters: Type.Object({}) };
		const patches: SystemMessage[] = [
			{ role: "system", content: "", sections: { restart: "obsolete" }, timestamp: 1 },
			{ role: "system", content: "", sections: { restart: null }, timestamp: 2 },
			{
				role: "system",
				content: [{ type: "text", text: "Keep this content", textSignature: "opaque" }],
				sections: { restart: null, unrelated: "Keep this section" },
				toolsAdded: [added],
				toolsRemoved: [{ name: "work" }],
				timestamp: 3,
			},
			{ role: "system", content: "Keep this text", sections: { restart: "obsolete" }, timestamp: 4 },
			{ role: "system", content: [], sections: { restart: null }, toolsRemoved: [{ name: "added" }], timestamp: 5 },
		];
		const f = await managedFixture({
			extensions: [
				(pi) => {
					pi.on("context_with_system", (event) => ({
						messages: [...event.messages, ...structuredClone(patches)],
					}));
				},
			],
		});
		f.faux.setResponses([f.response()]);
		await f.h.session.prompt("Seed");
		restartSection(f.requests[0]);
		expect(f.requests[0].messages.slice(-3)).toEqual([
			{ ...patches[2], sections: { unrelated: "Keep this section" } },
			{ role: "system", content: "Keep this text", timestamp: 4 },
			{ role: "system", content: [], toolsRemoved: [{ name: "added" }], timestamp: 5 },
		]);
		expect(f.requests[0].messages.filter((message) => message.role === "system")).toHaveLength(4);
	});
});
