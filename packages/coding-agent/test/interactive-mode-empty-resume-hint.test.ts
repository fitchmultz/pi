import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { Container } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { formatEmptySessionResumeHint, InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const maybeShowEmptySessionResumeHint = Reflect.get(InteractiveMode.prototype, "maybeShowEmptySessionResumeHint") as (
	this: Record<string, unknown>,
) => Promise<void>;

let tempRoot: string | undefined;

beforeAll(() => {
	initTheme("dark");
});

afterEach(() => {
	if (tempRoot) {
		rmSync(tempRoot, { recursive: true, force: true });
		tempRoot = undefined;
	}
});

function renderContainer(container: Container): string {
	return stripAnsi(container.children.flatMap((child) => child.render(160)).join("\n")).trim();
}

describe("InteractiveMode empty-session /resume hint", () => {
	test("formats singular, plural, and astral-codepoint labels cleanly", () => {
		expect(formatEmptySessionResumeHint([])).toBeUndefined();
		expect(
			formatEmptySessionResumeHint([
				{
					path: "/tmp/a.jsonl",
					id: "a",
					cwd: "/tmp",
					name: "gemini-thinking-trace",
					created: new Date(1),
					modified: new Date(2),
					messageCount: 12,
					firstMessage: "hello",
					allMessagesText: "hello",
				},
			]),
		).toBe('1 saved session in this directory (latest: "gemini-thinking-trace"). Run /resume to continue.');

		const emojiPrompt = `${"🚀".repeat(62)} launch`;
		const formatted = formatEmptySessionResumeHint([
			{
				path: "/tmp/b.jsonl",
				id: "b",
				cwd: "/tmp",
				created: new Date(1),
				modified: new Date(3),
				messageCount: 4,
				firstMessage: emojiPrompt,
				allMessagesText: emojiPrompt,
			},
			{
				path: "/tmp/a.jsonl",
				id: "a",
				cwd: "/tmp",
				created: new Date(1),
				modified: new Date(2),
				messageCount: 2,
				firstMessage: "older",
				allMessagesText: "older",
			},
		]);
		expect(formatted).toContain("2 saved sessions in this directory");
		expect(formatted).not.toContain("\uFFFD");
		expect(formatted).toMatch(/\.\.\."\)\. Run \/resume to continue\.$/);
	});

	test("renders /resume hint on empty persisted startup when directory has prior sessions", async () => {
		tempRoot = mkdtempSync(join(tmpdir(), "pi-resume-hint-"));
		const cwd = join(tempRoot, "project");
		const sessionDir = join(tempRoot, "sessions");
		const agentDir = join(tempRoot, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(sessionDir, { recursive: true });
		mkdirSync(agentDir, { recursive: true });

		const prior = SessionManager.create(cwd, sessionDir);
		prior.appendSessionInfo("maya-investigation");
		prior.appendMessage({ role: "user", content: "Check GPU residency", timestamp: 1 });

		const fresh = SessionManager.create(cwd, sessionDir);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			settingsManager: SettingsManager.inMemory(),
			sessionManager: fresh,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			thinkingLevel: "off",
		});
		// Real createAgentSession appends setup entries (model_change, thinking_level_change) before InteractiveMode.run().
		expect(fresh.getEntries().length).toBeGreaterThan(0);

		const chatContainer = new Container();
		const requestRender = vi.fn();

		try {
			await maybeShowEmptySessionResumeHint.call({
				options: {},
				sessionManager: fresh,
				session,
				isInitialized: true,
				isShuttingDown: false,
				pendingUserInputs: [],
				chatContainer,
				ui: { requestRender },
			});

			expect(requestRender).toHaveBeenCalledOnce();
			expect(renderContainer(chatContainer)).toContain(
				'1 saved session in this directory (latest: "maya-investigation"). Run /resume to continue.',
			);
		} finally {
			session.dispose();
		}
	});

	test("skips hint when startup has initial messages, --no-session, or existing entries", async () => {
		tempRoot = mkdtempSync(join(tmpdir(), "pi-resume-hint-skip-"));
		const cwd = join(tempRoot, "project");
		const sessionDir = join(tempRoot, "sessions");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(sessionDir, { recursive: true });

		const prior = SessionManager.create(cwd, sessionDir);
		prior.appendMessage({ role: "user", content: "Earlier turn", timestamp: 1 });

		const fresh = SessionManager.create(cwd, sessionDir);
		const chatContainer = new Container();
		const requestRender = vi.fn();

		// 1. CLI initialMessage provided
		await maybeShowEmptySessionResumeHint.call({
			options: { initialMessage: "Start new task" },
			sessionManager: fresh,
			session: { isStreaming: false },
			isInitialized: true,
			isShuttingDown: false,
			pendingUserInputs: [],
			chatContainer,
			ui: { requestRender },
		});
		expect(chatContainer.children).toHaveLength(0);

		// 2. --no-session (inMemory)
		await maybeShowEmptySessionResumeHint.call({
			options: {},
			sessionManager: SessionManager.inMemory(cwd),
			session: { isStreaming: false },
			isInitialized: true,
			isShuttingDown: false,
			pendingUserInputs: [],
			chatContainer,
			ui: { requestRender },
		});
		expect(chatContainer.children).toHaveLength(0);

		// 3. Resumed session already has entries
		await maybeShowEmptySessionResumeHint.call({
			options: {},
			sessionManager: prior,
			session: { isStreaming: false },
			isInitialized: true,
			isShuttingDown: false,
			pendingUserInputs: [],
			chatContainer,
			ui: { requestRender },
		});
		expect(chatContainer.children).toHaveLength(0);
		expect(requestRender).not.toHaveBeenCalled();
	});
});
