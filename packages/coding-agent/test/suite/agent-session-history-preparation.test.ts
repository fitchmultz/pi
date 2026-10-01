import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness } from "./harness.ts";

vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof fs>();
	return { ...actual, readSync: vi.fn(actual.readSync), statSync: vi.fn(actual.statSync) };
});

it("prepares a tool successor without rereading unchanged history and preserves the provider transcript", async () => {
	const directory = fs.mkdtempSync(join(tmpdir(), "pi-next-turn-history-"));
	const manager = SessionManager.create(directory, directory);
	const historical = Array.from({ length: 256 }, (_, index) => `historical-${index}`);
	for (const [index, content] of historical.entries())
		manager.appendMessage({ role: "user", content, timestamp: index });
	const noop: AgentTool = {
		name: "noop",
		label: "Noop",
		description: "Local no-op",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "tool result" }], details: {} }),
	};
	const harness = await createHarness({
		sessionManager: SessionManager.open(manager.getSessionFile()!),
		models: [{ id: "faux-1", contextWindow: 1_000_000 }],
		tools: [noop],
		settings: { compaction: { enabled: false }, retry: { enabled: false } },
	});
	try {
		const requests: string[] = [];
		harness.setResponses([
			(context) => {
				requests.push(JSON.stringify(context));
				return fauxAssistantMessage(fauxToolCall("noop", {}, { id: "call-noop" }), { stopReason: "toolUse" });
			},
			(context) => {
				requests.push(JSON.stringify(context));
				return fauxAssistantMessage("done");
			},
		]);
		vi.mocked(fs.readSync).mockClear();
		vi.mocked(fs.statSync).mockClear();
		await harness.session.prompt("next input");
		expect(requests).toHaveLength(2);
		for (const request of requests) {
			const positions = historical.map((content) => request.indexOf(`"${content}"`));
			expect(
				positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1])),
			).toBe(true);
		}
		expect(requests[1]).toContain("call-noop");
		expect(requests[1]).toContain("tool result");
		expect(vi.mocked(fs.readSync).mock.calls.length).toBeLessThan(32);
		expect(
			vi.mocked(fs.statSync).mock.calls.filter(([path]) => path === manager.getSessionFile()).length,
		).toBeLessThan(128);
		expect(harness.sessionManager.buildSessionContext().messages).toEqual(harness.session.messages);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	} finally {
		harness.cleanup();
		vi.restoreAllMocks();
		fs.rmSync(directory, { recursive: true, force: true });
	}
});
