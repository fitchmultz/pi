import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, onTestFinished } from "vitest";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { createHarness, getMessageText } from "./harness.ts";

const settings = { compaction: { enabled: false }, retry: { enabled: false } };

describe("AgentSession last answer", () => {
	it("keeps a completed answer after rollover and file-backed SDK resume without another request", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-last-answer-"));
		onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
		const harness = await createHarness({
			tools: [],
			settings,
			sessionManager: SessionManager.create(directory, directory),
			extensionFactories: [
				(pi) => {
					pi.on("turn_end", (_event, ctx) => ctx.newContext({ handoff: "completed" }));
				},
			],
		});
		onTestFinished(() => harness.cleanup());
		harness.setResponses([fauxAssistantMessage("finished"), fauxAssistantMessage("must remain unused")]);
		await harness.session.prompt("finish once");
		const liveAnswer = harness.session.getLastAssistantText();

		const { session: resumed } = await createAgentSession({
			cwd: directory,
			agentDir: directory,
			model: harness.getModel(),
			modelRuntime: harness.session.modelRuntime,
			settingsManager: harness.settingsManager,
			resourceLoader: createTestResourceLoader(),
			sessionManager: SessionManager.open(harness.session.sessionFile!),
			tools: [],
		});
		onTestFinished(() => resumed.dispose());

		expect(harness.session.messages.map((message) => message.role)).toEqual(["custom"]);
		expect(resumed.messages.map((message) => message.role)).toEqual(["custom"]);
		expect([liveAnswer, resumed.getLastAssistantText()]).toEqual(["finished", "finished"]);
		expect(resumed.sessionId).toBe(harness.session.sessionId);
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("uses only the selected branch and returns no answer at the root", async () => {
		const harness = await createHarness({ tools: [], settings });
		onTestFinished(() => harness.cleanup());
		harness.setResponses([
			fauxAssistantMessage("common"),
			fauxAssistantMessage("branch A"),
			fauxAssistantMessage("branch B"),
		]);
		await harness.session.prompt("start");
		const root = harness.sessionManager.getBranch()[0]!.id;
		const common = harness.sessionManager.getLeafId()!;
		await harness.session.prompt("try A");
		harness.session.newContext();
		const windowA = harness.sessionManager.getLeafId()!;
		await harness.session.navigateTree(common);
		await harness.session.prompt("try B");
		harness.session.newContext();
		const windowB = harness.sessionManager.getLeafId()!;

		await harness.session.navigateTree(windowA);
		const answerA = harness.session.getLastAssistantText();
		await harness.session.navigateTree(root);
		const rootAnswer = harness.session.getLastAssistantText();
		expect(harness.session.messages).toEqual([]);
		expect(harness.sessionManager.getBranch()).toEqual([]);
		await harness.session.navigateTree(windowB);

		expect([answerA, rootAnswer, harness.session.getLastAssistantText()]).toEqual([
			"branch A",
			undefined,
			"branch B",
		]);
		expect(harness.faux.state.callCount).toBe(3);
	});

	it("prefers the active answer during message_end before it is persisted", async () => {
		const harness = await createHarness({ tools: [], settings });
		onTestFinished(() => harness.cleanup());
		harness.setResponses([fauxAssistantMessage("older"), fauxAssistantMessage("newer")]);
		await harness.session.prompt("first");
		harness.session.newContext();
		const seen: Array<{ answer: string | undefined; persisted: string[] }> = [];
		harness.session.subscribe((event) => {
			if (event.type !== "message_end" || event.message.role !== "assistant") return;
			seen.push({
				answer: harness.session.getLastAssistantText(),
				persisted: harness.sessionManager
					.getBranch()
					.flatMap((entry) =>
						entry.type === "message" && entry.message.role === "assistant" ? [getMessageText(entry.message)] : [],
					),
			});
		});

		await harness.session.prompt("second");

		expect(seen).toEqual([{ answer: "newer", persisted: ["older"] }]);
	});

	it.each([
		{ name: "empty completed response", response: fauxAssistantMessage([]), expected: undefined },
		{ name: "whitespace response", response: fauxAssistantMessage(" \n "), expected: undefined },
		{
			name: "thinking-only response",
			response: fauxAssistantMessage({ type: "thinking", thinking: "thinking" }),
			expected: undefined,
		},
		{
			name: "empty error response",
			response: fauxAssistantMessage([], { stopReason: "error", errorMessage: "invalid request" }),
			expected: undefined,
		},
		{
			name: "empty aborted response",
			response: fauxAssistantMessage([], { stopReason: "aborted" }),
			expected: "older",
		},
		{
			name: "blank aborted text",
			response: fauxAssistantMessage("", { stopReason: "aborted" }),
			expected: undefined,
		},
		{
			name: "partial aborted text",
			response: fauxAssistantMessage(" partial ", { stopReason: "aborted" }),
			expected: "partial",
		},
	])("preserves $name eligibility in active and stored history", async ({ response, expected }) => {
		const harness = await createHarness({ tools: [], settings });
		onTestFinished(() => harness.cleanup());
		harness.setResponses([fauxAssistantMessage("older"), response]);
		await harness.session.prompt("first");
		harness.session.newContext();
		await harness.session.prompt("second");
		const activeAnswer = harness.session.getLastAssistantText();
		harness.session.newContext();

		expect([activeAnswer, harness.session.getLastAssistantText()]).toEqual([expected, expected]);
		expect(harness.faux.state.callCount).toBe(2);
	});
});
