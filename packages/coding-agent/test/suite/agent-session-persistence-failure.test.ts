import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof fs>();
	return { ...actual, appendFileSync: vi.fn(actual.appendFileSync) };
});

describe("AgentSession final persistence", () => {
	let directory: string;
	let harness: Harness | undefined;

	beforeEach(() => {
		directory = fs.mkdtempSync(join(tmpdir(), "pi-settlement-failure-"));
	});

	afterEach(() => {
		vi.mocked(fs.appendFileSync).mockRestore();
		harness?.cleanup();
		harness = undefined;
		fs.rmSync(directory, { recursive: true, force: true });
	});

	it.each([
		{ kind: "custom", failSave: true },
		{ kind: "bash", failSave: true },
		{ kind: "custom", failSave: false },
		{ kind: "bash", failSave: false },
	])("settles and retains $kind messages exactly once (save failure: $failSave)", async ({ kind, failSave }) => {
		const manager = SessionManager.create(directory, directory);
		harness = await createHarness({ sessionManager: manager });
		const { session } = harness;
		harness.setResponses([fauxAssistantMessage("done"), fauxAssistantMessage("recovered")]);
		const saveError = new Error("ENOSPC: journal is full");
		const accepted: Promise<void>[] = [];
		let idle: Promise<void> | undefined;
		const unsubscribe = session.subscribe((event) => {
			if (event.type !== "agent_end") return;
			unsubscribe();
			idle = session.waitForIdle();
			for (const content of ["first background result", "second background result"]) {
				if (kind === "custom") {
					accepted.push(
						session.sendCustomMessage(
							{ customType: "background", content, display: true },
							{ triggerTurn: false },
						),
					);
				} else {
					session.recordBashResult(content, { output: content, exitCode: 0, cancelled: false, truncated: false });
				}
			}
			// Fail the real journal append after SessionManager has accepted the first deferred entry.
			if (failSave)
				vi.mocked(fs.appendFileSync).mockImplementationOnce(() => {
					throw saveError;
				});
		});

		const prompt = session.prompt("start");
		if (failSave) await expect(prompt).rejects.toBe(saveError);
		else await prompt;
		await Promise.all(accepted);
		expect(session.agent.state.isStreaming).toBe(false);
		expect(session.isIdle).toBe(true);
		expect(session.isStreaming).toBe(false);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
		await idle;
		await session.abort();

		manager.flush();
		await session.prompt("continue after storage recovery");
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(session.isIdle).toBe(true);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(2);
		const reopened = SessionManager.open(manager.getSessionFile()!);
		expect(reopened.getEntries()).toEqual(manager.getEntries());
		for (const messages of [session.messages, reopened.buildSessionContext().messages]) {
			expect(
				messages.flatMap((message) => {
					if (message.role === "custom" && message.customType === "background") return [message.content];
					if (message.role === "bashExecution") return [message.output];
					return [];
				}),
			).toEqual(["first background result", "second background result"]);
		}
	});
});
