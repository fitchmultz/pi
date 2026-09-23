import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import * as fs from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
} from "../../src/core/agent-session-runtime.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { createHarness, type Harness } from "./harness.ts";

vi.mock("fs", async (importOriginal) => {
	const original = await importOriginal<typeof fs>();
	return { ...original, appendFileSync: vi.fn(original.appendFileSync) };
});

type SessionView = {
	isInitialized: boolean;
	bindCurrentSessionExtensions(): Promise<void>;
	handleClearCommand(): Promise<void>;
	handleResumeSession(path: string): Promise<{ cancelled: boolean }>;
	handleImportCommand(text: string): Promise<void>;
	showExtensionConfirm(): Promise<boolean>;
	recordCrash(): boolean;
};

const cleanups: Array<() => void> = [];
afterEach(() => {
	vi.mocked(fs.appendFileSync).mockRestore();
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	vi.restoreAllMocks();
});

async function createView() {
	const directory = fs.mkdtempSync(join(tmpdir(), "pi-interactive-persistence-"));
	cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
	const harnesses: Harness[] = [];
	const factory = vi.fn<CreateAgentSessionRuntimeFactory>(async ({ sessionManager }) => {
		const harness = await createHarness({
			sessionManager,
			tools: [],
			settings: { compaction: { enabled: false }, retry: { enabled: false } },
		});
		harnesses.push(harness);
		cleanups.push(harness.cleanup);
		return {
			session: harness.session,
			extensionsResult: harness.session.resourceLoader.getExtensions(),
			services: {
				cwd: directory,
				agentDir: directory,
				modelRuntime: harness.session.modelRuntime,
				settingsManager: harness.settingsManager,
				resourceLoader: harness.session.resourceLoader,
				diagnostics: [],
			},
			diagnostics: [],
		};
	});
	const runtime = await createAgentSessionRuntime(factory, {
		cwd: directory,
		agentDir: directory,
		sessionManager: SessionManager.create(directory, join(directory, "sessions")),
	});
	initTheme("dark");
	const mode = new InteractiveMode(runtime, { terminal: new VirtualTerminal(120, 40) });
	const view = mode as unknown as SessionView;
	view.isInitialized = true;
	await view.bindCurrentSessionExtensions();
	cleanups.push(() => mode.stop("resume-hint"));
	vi.spyOn(view, "showExtensionConfirm").mockResolvedValue(true);
	vi.spyOn(view, "recordCrash").mockReturnValue(false);
	const showError = vi.spyOn(mode, "showError");
	const exitError = new Error("process.exit");
	const exit = vi.spyOn(process, "exit").mockImplementation(() => {
		throw exitError;
	});
	return { runtime, view, factory, harness: harnesses[0], directory, showError, exit, exitError };
}

describe("interactive session persistence", () => {
	// PR #99: a failed outgoing flush must not send the still-live session through fatal process exit.
	it.each(["new", "extension new", "extension fork", "resume", "import", "resume missing cwd", "import missing cwd"])(
		"keeps the outgoing session usable after a save failure during %s and permits retry",
		async (operation) => {
			const { runtime, view, harness, directory, showError, exit, exitError } = await createView();
			harness.setResponses([fauxAssistantMessage("saved"), fauxAssistantMessage("unsaved response")]);
			await runtime.session.prompt("first");
			const outgoing = runtime.session;
			const journal = outgoing.sessionFile!;
			let target = journal;
			if (operation.endsWith("missing cwd")) {
				const other = SessionManager.create(join(directory, "missing"), join(directory, "sessions"));
				other.appendMessage(fauxAssistantMessage("other session"));
				target = other.getSessionFile()!;
			}
			const writeError = Object.assign(new Error("journal write failed"), { code: "EACCES" });
			const unsubscribe = outgoing.subscribe((event) => {
				if (event.type === "message_end" && event.message.role === "assistant") {
					vi.mocked(fs.appendFileSync).mockImplementation(() => {
						throw writeError;
					});
				}
			});
			await outgoing.prompt("second").catch(() => {});
			unsubscribe();
			const accepted = outgoing.sessionManager
				.getEntries()
				.find(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "assistant" &&
						entry.message.content.some((part) => part.type === "text" && part.text === "unsaved response"),
				)!;
			expect(accepted).toBeDefined();
			expect(SessionManager.open(journal).getEntry(accepted.id)).toBeUndefined();
			const ctx = outgoing.extensionRunner.createCommandContext();
			const invoke = () => {
				if (operation === "extension new") return ctx.newSession();
				if (operation === "extension fork") return ctx.fork(outgoing.getUserMessagesForForking()[0].entryId);
				if (operation.startsWith("resume")) return view.handleResumeSession(target);
				if (operation.startsWith("import")) return view.handleImportCommand(`/import ${target}`);
				return view.handleClearCommand();
			};
			await invoke().catch((error) => {
				if (error !== exitError) throw error;
			});
			expect(exit).not.toHaveBeenCalled();
			expect(showError).toHaveBeenCalledWith(expect.stringContaining("journal write failed"));
			expect(runtime.session).toBe(outgoing);
			expect(ctx.cwd).toBe(harness.tempDir);
			expect(view.isInitialized).toBe(true);
			expect(outgoing.sessionManager.getEntry(accepted.id)).toEqual(accepted);

			vi.mocked(fs.appendFileSync).mockRestore();
			await invoke();
			expect(runtime.session).not.toBe(outgoing);
			expect(SessionManager.open(journal).getEntry(accepted.id)).toEqual(accepted);
			expect(exit).not.toHaveBeenCalled();
		},
	);

	it("still exits when creating the replacement fails after disposing the outgoing session", async () => {
		const { runtime, view, factory, showError, exit, exitError } = await createView();
		const ctx = runtime.session.extensionRunner.createContext();
		factory.mockRejectedValueOnce(new Error("replacement initialization failed"));
		await expect(view.handleClearCommand()).rejects.toBe(exitError);
		expect(exit).toHaveBeenCalledWith(1);
		expect(showError).toHaveBeenCalledWith("Failed to create session: replacement initialization failed");
		expect(() => ctx.cwd).toThrow(/stale/);
	});
});
