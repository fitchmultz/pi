import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	getCurrentSystemPrompt,
	type Model,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { streamSimple as codexStream } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { streamSimple as completionsStream } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as responsesStream } from "@earendil-works/pi-ai/api/openai-responses";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MANAGED_CLI_ENV, RESTART_SOCKET_ENV } from "../src/cli/restart-protocol.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { BackgroundWork } from "../src/core/background-work.ts";
import { clearExtensionCache } from "../src/core/extensions/loader.ts";
import type { ExtensionFactory, ExtensionUIContext } from "../src/core/extensions/types.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { getGitUpdateMarkerPath } from "../src/core/package-manager.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { type Settings, SettingsManager } from "../src/core/settings-manager.ts";
import restartExtension, { createManagedRestart } from "../src/extensions/restart/index.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createTestUiContext } from "./suite/harness.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// Vitest's fork supplies real IPC admission; the actual owner creates/cleans its native socket.
// No launcher replacement or installed runtime is involved in this source-level regression.
async function managedFixture(
	options: {
		sessionFile?: string;
		extensions?: ExtensionFactory[];
		/** Settings on top of the fixture's. With `packages`, the loader loads their extensions from disk. */
		settings?: Partial<Settings>;
		mode?: "tui" | "print";
		ui?: Partial<ExtensionUIContext>;
	} = {},
) {
	const root = mkdtempSync(join(tmpdir(), "pi-restart-guidance-"));
	const disconnectHandlers = new Set(process.listeners("disconnect"));
	expect(process.send).toBeTypeOf("function");
	expect(process.connected).toBe(true);
	vi.stubEnv(MANAGED_CLI_ENV, "1");
	const managed = createManagedRestart();
	expect(managed).toBeDefined();
	// The managed owner unrefs IPC, but Vitest loads modules for this worker over that channel. Without
	// the reference, the worker exits when such a load is all it waits for, as the lazy imports of the
	// first extension loaded from disk are.
	process.channel?.ref();
	const faux = fauxProvider();
	const sessionManager = options.sessionFile
		? SessionManager.open(options.sessionFile)
		: SessionManager.create(root, root);
	const cwd = sessionManager.getCwd();
	const settingsManager = SettingsManager.inMemory({ cacheWarming: "off", ...options.settings });
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: join(root, "agent"),
		settingsManager,
		noExtensions: options.settings?.packages === undefined,
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
	};
	cleanups.push(async () => {
		await close();
		rmSync(root, { recursive: true, force: true });
	});
	let shutdownRequested = false;
	// As the CLI does before the mode binds the extensions.
	managed!.bindSession(() => h.session);
	await h.session.bindExtensions({
		mode: options.mode ?? "tui",
		uiContext: createTestUiContext(options.ui),
		shutdownHandler: () => {
			shutdownRequested = true;
		},
	});
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
	return { h, faux, requests, response, wake, close, managed: managed!, shutdownRequested: () => shutdownRequested };
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
	completionsCompatOverride?: Record<string, unknown>,
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
				? { supportsDeveloperRole: false, ...completionsCompatOverride }
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
	it.skipIf(process.platform === "win32")(
		"captures restart privately without changing a group-writable journal directory",
		async () => {
			const f = await managedFixture();
			f.faux.setResponses([f.response()]);
			await f.h.session.prompt("save the native journal");
			const journalDir = f.h.sessionManager.getSessionDir();
			chmodSync(journalDir, 0o775);
			f.managed.bindInput(() => ({ busy: false, pendingInput: false }));
			f.managed.start();
			await f.h.session.prompt("/restart");
			await vi.waitFor(() => expect(f.shutdownRequested()).toBe(true));
			expect(f.managed.beginShutdown("extension")).toBe(true);
			const writeSpy = vi.spyOn(process, "send");
			try {
				expect(await f.managed.captureFinal(f.h.session)).toBe(true);
				await f.managed.completeShutdown();
				const message = writeSpy.mock.calls
					.map(([message]) => message)
					.find(
						(message) =>
							typeof message === "object" &&
							message !== null &&
							"type" in message &&
							message.type === "pi:restart",
					);
				if (!message || typeof message !== "object" || !("session" in message))
					throw new Error("Missing restart handoff");
				const session = message.session as { workingSession: string };
				expect(dirname(session.workingSession)).not.toBe(journalDir);
				expect(statSync(dirname(session.workingSession)).mode & 0o777).toBe(0o700);
				expect(statSync(session.workingSession).mode & 0o777).toBe(0o600);
				expect(JSON.parse(readFileSync(session.workingSession, "utf8")).header.id).toBe(f.h.session.sessionId);
				expect(statSync(journalDir).mode & 0o777).toBe(0o775);
				expect(existsSync(f.h.session.sessionFile!)).toBe(true);
				rmSync(dirname(session.workingSession), { recursive: true });
			} finally {
				writeSpy.mockRestore();
			}
		},
	);
	it.each(["idle", "deferred"] as const)(
		"keeps the serialized head across %s wake, tools, and next user with one hook per run",
		async (delivery) => {
			const hooks: string[] = [];
			let queued = false;
			const f = await managedFixture({
				extensions: [
					(pi) => {
						pi.on("before_agent_start", (event) => {
							hooks.push(event.messageType);
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
			expect(hooks).toEqual(["user", "custom"]);
			f.faux.setResponses([f.response()]);
			await f.h.session.prompt("Next user");
			expect(hooks).toEqual(["user", "custom", "user"]);
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
		const hooks: string[] = [];
		const reopened = await managedFixture({
			sessionFile: file,
			extensions: [
				(pi) => {
					pi.on("before_agent_start", (event) => {
						hooks.push(event.messageType);
					});
				},
			],
		});
		await reopened.wake();
		expect(hooks).toEqual(["custom"]);
		expect(f.requests).toHaveLength(3);
		expect(reopened.requests).toHaveLength(2);
		for (const request of [...f.requests, ...reopened.requests]) restartSection(request);
		await expectStableRequests([...f.requests, ...reopened.requests]);
	});

	it("supplies guidance and base sections from the first request of a fresh custom run", async () => {
		const hooks: string[] = [];
		const f = await managedFixture({
			extensions: [
				(pi) => {
					pi.on("before_agent_start", (event) => {
						hooks.push(event.messageType);
					});
				},
			],
		});
		await f.wake();
		expect(hooks).toEqual(["custom"]);
		expect(f.requests).toHaveLength(2);
		for (const request of f.requests) restartSection(request);
		// Custom-message runs prepare the full prompt before their first request (#10739), so the head stays stable.
		await expectStableRequests(f.requests);
	});

	it("appends actual guidance exactly once to post-hook forced text, never persists or revives it", async () => {
		const hooks: string[] = [];
		const f = await managedFixture({
			extensions: [
				(pi) => {
					pi.on("before_agent_start", (event) => {
						hooks.push(event.messageType);
						if (event.messageType === "user" && event.prompt === "Force")
							event.systemPromptOptions.forceSystemPrompt = "Exact forced text.";
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
		expect(hooks).toEqual(["user", "user", "custom"]);
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

	it("gives a forked child session without managed control the parent's leading system message and a recorded removal", async () => {
		const f = await managedFixture();
		f.faux.setResponses([f.response()]);
		await f.h.session.prompt("Seed");
		const parentRequest = f.requests[0].messages;
		// A forked child's journal: its own header, then the parent's branch.
		const childRoot = mkdtempSync(join(tmpdir(), "pi-restart-guidance-child-"));
		cleanups.push(async () => rmSync(childRoot, { recursive: true, force: true }));
		const created = SessionManager.create(childRoot, childRoot);
		const file = created.getSessionFile()!;
		const journal = [
			{ ...created.getHeader(), parentSession: f.h.sessionManager.getSessionFile() },
			...f.h.sessionManager.getBranch(),
		];
		writeFileSync(file, `${journal.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
		await f.close();
		const child = await managedFixture({ sessionFile: file, mode: "print" });
		child.faux.setResponses([child.response()]);
		await child.h.session.prompt("Child task");
		const childRequest = child.requests[0].messages;
		restartSection(f.requests[0]);
		// The provider's cached prefix and its thinking blocks stay valid only for the same leading bytes.
		expect(childRequest.slice(0, parentRequest.length)).toEqual(parentRequest);
		const later = childRequest
			.slice(parentRequest.length)
			.flatMap((message) => (message.role === "system" ? [message] : []));
		expect(later.map((message) => message.sections?.restart).filter((section) => section !== undefined)).toEqual([
			null,
		]);
		expect(getCurrentSystemPrompt(childRequest)).not.toContain("<restart>");
		// What the provider gets: an API that takes later system messages keeps the parent's start.
		for (const api of ["openai-responses", "openai-codex-responses"] as const) {
			const [parent, forked] = await payloads([f.requests[0], child.requests[0]], api);
			expect(forked.instructions).toEqual(parent.instructions);
			expect(forked.input?.slice(0, parent.input?.length)).toEqual(parent.input);
			expect(forked.tools).toEqual(parent.tools);
		}
		const [parentCompletions, forkedCompletions] = await payloads(
			[f.requests[0], child.requests[0]],
			"openai-completions",
		);
		expect(forkedCompletions.messages?.slice(0, parentCompletions.messages?.length)).toEqual(
			parentCompletions.messages,
		);
		expect(JSON.stringify(forkedCompletions.messages?.slice(parentCompletions.messages?.length))).toContain(
			'Removed system prompt section \\"restart\\".',
		);
		// An API without them gets every later system message folded into the leading one.
		const [parent, forked] = await payloads([f.requests[0], child.requests[0]], "openai-completions", {
			supportsMidConvoSystemMessages: false,
		});
		expect(JSON.stringify(parent.messages?.[0])).toContain("<restart>");
		expect(JSON.stringify(forked.messages?.[0])).not.toContain("<restart>");
	});

	it("adds the guidance to a leading system message that was recorded without it", async () => {
		// The journal of a window recorded before the guidance was a saved section has no `restart`
		// in its leading system message; a session first run without managed control records the same.
		const recorded = await managedFixture({ mode: "print" });
		recorded.faux.setResponses([recorded.response()]);
		await recorded.h.session.prompt("Seed");
		const recordedHead = recorded.requests[0].messages[0];
		if (recordedHead?.role !== "system") throw new Error("Expected system head");
		expect(recordedHead.sections?.restart).toBeUndefined();
		const file = recorded.h.sessionManager.getSessionFile()!;
		await recorded.close();
		const managed = await managedFixture({ sessionFile: file });
		await managed.wake();
		expect(managed.requests).toHaveLength(2);
		for (const request of managed.requests) {
			const section = restartSection(request);
			expect(request.messages[0]).toEqual({
				...recordedHead,
				sections: { ...recordedHead.sections, restart: section },
			});
		}
		await expectStableRequests(managed.requests);
	});
});

describe("stale extension code in a managed session", () => {
	/**
	 * A managed, idle session that loaded one package from disk. The clock is fake but runs, so the
	 * session works as usual and a test can skip the waits between two looks at the disk.
	 */
	async function staleFixture(settings: Partial<Settings> = {}) {
		// The status is colored, as the interactive mode's theme colors it.
		initTheme("dark");
		vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "Date"] });
		const root = mkdtempSync(join(tmpdir(), "pi-restart-stale-"));
		cleanups.push(async () => {
			vi.useRealTimers();
			clearExtensionCache();
			rmSync(root, { recursive: true, force: true });
		});
		const packageDir = join(root, "fixture-package");
		mkdirSync(packageDir);
		const setVersion = (version: string) =>
			writeFileSync(
				join(packageDir, "package.json"),
				JSON.stringify({ name: "fixture-package", version, pi: { extensions: ["./extension.ts"] } }),
			);
		setVersion("1.0.0");
		writeFileSync(join(packageDir, "extension.ts"), "export default function () {}\n");
		const seen = {
			/** Latest `restart` footer status, and how often it was set: once per look at the disk. */
			status: "never set" as string | undefined,
			looks: 0,
			/** How often the editor was read: once per idle test. */
			editorReads: 0,
			/** How often the session's background work was asked for. */
			workAsks: 0,
			notices: [] as string[],
		};
		const state = { draft: "", work: [] as BackgroundWork[] };
		const f = await managedFixture({
			settings: { packages: [packageDir], ...settings },
			extensions: [
				(pi) => {
					pi.on("background_work", () => {
						seen.workAsks++;
						return { work: state.work };
					});
				},
			],
			ui: {
				setStatus: (key, text) => {
					if (key !== "restart") return;
					seen.status = text;
					seen.looks++;
				},
				getEditorText: () => {
					seen.editorReads++;
					return state.draft;
				},
				notify: (message) => {
					seen.notices.push(message);
				},
			},
		});
		f.managed.bindInput(() => ({ busy: false, pendingInput: false }));
		f.managed.start();
		const prompt = async (text: string) => {
			f.faux.setResponses([f.response()]);
			await f.h.session.prompt(text);
		};
		/** Change the package on disk and let the session notice it, as it does after every agent run. */
		const makeStale = async () => {
			setVersion("1.0.1");
			await prompt("After the change");
			await vi.waitFor(() => expect(seen.status).toContain("extensions changed on disk: /restart"));
		};
		return { ...f, prompt, makeStale, seen, state, packageDir };
	}

	it("shows a footer status once loaded code changed on disk, clears it on reload, and sends the model nothing", async () => {
		const f = await staleFixture();
		await f.prompt("Before the change");
		await vi.waitFor(() => expect(f.seen.status).toBeUndefined());

		await f.makeStale();
		await f.prompt("With the status shown");

		// Same tools and system prompt, and each request only extends the one before it.
		expect(f.requests).toHaveLength(3);
		await expectStableRequests(f.requests);
		expect(JSON.stringify(f.requests)).not.toContain("changed on disk");

		await f.h.session.reload();
		await vi.waitFor(() => expect(f.seen.status).toBeUndefined());
	});

	it("leaves a stale session alone unless restartWhenStale is on", async () => {
		const f = await staleFixture();
		await f.makeStale();
		const looks = f.seen.looks;
		// Past the quiet period and the next regular look at the disk.
		await vi.advanceTimersByTimeAsync(2 * 60_000);
		await vi.waitFor(() => expect(f.seen.looks).toBeGreaterThan(looks));
		expect(f.seen).toMatchObject({ editorReads: 0, workAsks: 0, notices: [] });
		expect(f.shutdownRequested()).toBe(false);
	});

	it("restarts an idle stale session through the managed restart, after the quiet period", async () => {
		const f = await staleFixture({ restartWhenStale: true });
		await f.makeStale();
		const looks = f.seen.looks;
		await vi.advanceTimersByTimeAsync(29_000);
		expect(f.seen.looks).toBe(looks);
		expect(f.shutdownRequested()).toBe(false);

		await vi.advanceTimersByTimeAsync(1_000);
		await vi.waitFor(() => expect(f.shutdownRequested()).toBe(true));
		expect(f.seen.notices).toEqual(["Extensions changed on disk; restarting Pi on the same saved session."]);
		// The same handoff as `/restart` without a continuation: the session, and no message to run.
		expect(f.managed.beginShutdown("extension")).toBe(true);
		const send = vi.spyOn(process, "send");
		try {
			expect(await f.managed.captureFinal(f.h.session)).toBe(true);
			await f.managed.completeShutdown();
			const handoff = send.mock.calls
				.map(([message]) => message as { type?: string; request?: object; session?: { workingSession: string } })
				.find((message) => message.type === "pi:restart");
			expect(handoff?.request).toEqual({});
			expect(handoff).toMatchObject({
				session: { sessionId: f.h.session.sessionId, sessionFile: f.h.session.sessionFile },
			});
			rmSync(dirname(handoff!.session!.workingSession), { recursive: true });
		} finally {
			send.mockRestore();
		}
	});

	it.each([
		{
			blocker: "an unsent draft",
			block: (f: Awaited<ReturnType<typeof staleFixture>>) => {
				f.state.draft = "half a thought";
				return () => {
					f.state.draft = "";
				};
			},
			decided: (f: Awaited<ReturnType<typeof staleFixture>>) => f.seen.editorReads,
		},
		{
			blocker: "an unfinished package update",
			block: (f: Awaited<ReturnType<typeof staleFixture>>) => {
				// As `pi update` leaves it between moving the commit and finishing the install.
				const marker = getGitUpdateMarkerPath(f.packageDir);
				writeFileSync(marker, "");
				return () => rmSync(marker);
			},
			decided: (f: Awaited<ReturnType<typeof staleFixture>>) => f.seen.looks,
		},
		{
			blocker: "background work",
			block: (f: Awaited<ReturnType<typeof staleFixture>>) => {
				f.state.work = [{ id: "run-1", description: "run is active", cancel: async () => {} }];
				return () => {
					f.state.work = [];
				};
			},
			decided: (f: Awaited<ReturnType<typeof staleFixture>>) => f.seen.workAsks,
		},
	])("postpones the restart silently during $blocker, then restarts", async ({ block, decided }) => {
		const f = await staleFixture({ restartWhenStale: true });
		await f.makeStale();
		const unblock = block(f);
		const before = decided(f);
		await vi.advanceTimersByTimeAsync(30_000);
		await vi.waitFor(() => expect(decided(f)).toBeGreaterThan(before));
		expect(f.seen.notices).toEqual([]);
		expect(f.shutdownRequested()).toBe(false);

		unblock();
		await vi.advanceTimersByTimeAsync(30_000);
		await vi.waitFor(() => expect(f.shutdownRequested()).toBe(true));
	});
});
