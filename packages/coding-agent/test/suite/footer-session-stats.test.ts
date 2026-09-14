import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, type Usage } from "@earendil-works/pi-ai";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ReadonlyFooterDataProvider } from "../../src/core/footer-data-provider.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { FooterComponent } from "../../src/modes/interactive/components/footer.ts";
import { initTheme, setTheme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { createHarness, type Harness } from "./harness.ts";

function assistant(input = 100, cacheRead = 50, cacheWrite = 50) {
	return {
		...fauxAssistantMessage("ok"),
		usage: {
			input,
			output: 10,
			cacheRead,
			cacheWrite,
			totalTokens: input + 10 + cacheRead + cacheWrite,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 },
		} satisfies Usage,
	};
}

function footerData(): ReadonlyFooterDataProvider {
	return {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map(),
		getAvailableProviderCount: () => 1,
		onBranchChange: () => () => {},
	};
}

function render(footer: FooterComponent): string[] {
	return footer.render(160).map(stripAnsi);
}

describe("Footer session statistics", () => {
	const harnesses: Harness[] = [];
	beforeAll(() => initTheme("dark", false));
	afterEach(() => {
		vi.restoreAllMocks();
		setTheme("dark");
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it("does not scan unchanged session entries or names on redraw, while live display state stays fresh", async () => {
		const harness = await createHarness({ tools: [] });
		harnesses.push(harness);
		const sm = harness.sessionManager;
		sm.appendSessionInfo("Long session");
		for (let i = 0; i < 200; i++) sm.appendMessage(assistant());
		harness.session.agent.state.messages = sm.buildSessionContext().messages;
		const data = footerData();
		const footer = new FooterComponent(harness.session, data);
		const initial = render(footer);
		const entries = vi.spyOn(sm, "getEntries");
		const name = vi.spyOn(sm, "getSessionName");
		for (let i = 0; i < 5; i++) {
			footer.invalidate();
			expect(render(footer)).toEqual(initial);
		}
		expect(entries).not.toHaveBeenCalled();
		expect(name).not.toHaveBeenCalled();

		vi.spyOn(data, "getGitBranch").mockReturnValue("other");
		vi.spyOn(data, "getExtensionStatuses").mockReturnValue(new Map([["status", "Working\nnow"]]));
		vi.spyOn(sm, "getCwd").mockReturnValue("/different/project");
		harness.session.agent.state.model = {
			...harness.getModel(),
			id: "new-model",
			reasoning: true,
			contextWindow: 1000,
		};
		harness.session.agent.state.thinkingLevel = "high";
		harness.session.agent.state.messages = [];
		footer.setAutoCompactEnabled(false);
		setTheme("light");
		const changed = render(footer);
		expect(changed[0]).toBe("/different/project (other) • Long session");
		expect(changed[1]).toContain("new-model • high");
		expect(changed[1]).toContain("/1.0k");
		expect(changed[1]).not.toContain("(auto)");
		expect(changed[2]).toBe("Working now");
		for (const line of footer.render(40)) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
	});

	it("keeps file-wide usage and latest assistant cache hit rate when an alternate branch restores the same leaf", async () => {
		const harness = await createHarness({ tools: [] });
		harnesses.push(harness);
		const sm = harness.sessionManager;
		sm.appendSessionInfo("Original");
		const leaf = sm.appendMessage(assistant());
		harness.session.agent.state.messages = sm.buildSessionContext().messages;
		const footer = new FooterComponent(harness.session, footerData());
		expect(render(footer)[1]).toContain("↑100 ↓10 R50 W50 CH25.0% $0.500");

		sm.branch(leaf);
		sm.appendMessage(assistant(50, 150, 0));
		sm.appendMessage({
			role: "toolResult",
			toolCallId: "call",
			toolName: "nested",
			content: [],
			isError: false,
			timestamp: 0,
			usage: assistant().usage,
		});
		sm.appendCompaction("summary", leaf, 200, undefined, false, assistant().usage);
		sm.branchWithSummary(leaf, "branch summary", undefined, false, assistant().usage);
		sm.appendSessionInfo("Renamed\nbranch");
		sm.branch(leaf);
		expect(sm.getLeafId()).toBe(leaf);
		const changed = render(footer);
		expect(changed[0]).toContain(" • Renamed branch");
		expect(changed[1]).toContain("↑450 ↓50 R350 W200 CH75.0% $2.500");
		expect(changed[1]).toContain(`/${harness.getModel().contextWindow / 1000}k`);

		sm.appendSessionInfo(" \n ");
		sm.branch(leaf);
		expect(render(footer)[0]).not.toContain(" • ");
		sm.appendMessage({ ...assistant(0, 0, 0), usage: { ...assistant(0, 0, 0).usage, output: 0, totalTokens: 0 } });
		sm.branch(leaf);
		expect(render(footer)[1]).not.toContain("CH");
	});

	it("refreshes after same-manager reload, switch, branch extraction, and new session", async () => {
		const harness = await createHarness({ tools: [] });
		harnesses.push(harness);
		const sm = harness.sessionManager;
		sm.appendSessionInfo("First");
		const leaf = sm.appendMessage(assistant());
		const original = [sm.getHeader()!, ...sm.getEntries()];
		const path = join(harness.tempDir, "session.jsonl");
		writeFileSync(path, `${original.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
		const footer = new FooterComponent(harness.session, footerData());
		const first = render(footer);
		sm.setSessionFile(path);
		expect(render(footer)).toEqual(first);

		// Same header, leaf IDs, entry count, and manager; only loaded contents change.
		const replacement = original.map((entry) =>
			entry.type === "session_info"
				? { ...entry, name: "Reloaded" }
				: entry.type === "message"
					? { ...entry, message: assistant(300) }
					: entry,
		);
		writeFileSync(path, `${replacement.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
		sm.setSessionFile(path);
		expect(render(footer)[0]).toContain(" • Reloaded");
		expect(render(footer)[1]).toContain("↑300");

		sm.appendMessage(assistant());
		sm.appendSessionInfo("Abandoned");
		render(footer);
		sm.createBranchedSession(leaf);
		expect(render(footer)[0]).toContain(" • Reloaded");
		expect(render(footer)[1]).toContain("↑300 ↓10");
		sm.newSession({ id: sm.getSessionId() });
		expect(render(footer)[0]).not.toContain(" • ");
		expect(render(footer)[1]).not.toContain("$0.500");
		sm.setSessionFile(path);
		expect(render(footer)[0]).toContain(" • Reloaded");
	});

	it("refreshes when setSession replaces the runtime, with either a shared or different manager", async () => {
		const first = await createHarness({ tools: [] });
		harnesses.push(first);
		first.sessionManager.appendSessionInfo("First");
		first.sessionManager.appendMessage(assistant());
		const footer = new FooterComponent(first.session, footerData());
		render(footer);
		const shared = await createHarness({ tools: [], sessionManager: first.sessionManager });
		harnesses.push(shared);
		shared.session.agent.state.model = { ...shared.getModel(), id: "replacement-model" };
		footer.setSession(shared.session);
		expect(render(footer)[1]).toContain("replacement-model");

		const second = await createHarness({ tools: [], sessionManager: SessionManager.inMemory("/second") });
		harnesses.push(second);
		second.sessionManager.appendSessionInfo("Second");
		second.sessionManager.appendMessage(assistant(900));
		footer.setSession(second.session);
		expect(render(footer)[0]).toBe("/second (main) • Second");
		expect(render(footer)[1]).toContain("↑900 ↓10");
	});
});
