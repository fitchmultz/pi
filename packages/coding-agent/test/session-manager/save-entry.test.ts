import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { type CustomEntry, SessionManager } from "../../src/core/session-manager.ts";

describe("SessionManager.saveCustomEntry", () => {
	it("saves custom entries and includes them in tree traversal", () => {
		const session = SessionManager.inMemory();

		const msgId = session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		const customId = session.appendCustomEntry("my_data", { foo: "bar" });
		const msg2Id = session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});

		const entries = session.getEntries();
		expect(entries).toHaveLength(3);

		const customEntry = entries.find((entry) => entry.type === "custom") as CustomEntry;
		expect(customEntry).toBeDefined();
		expect(customEntry.customType).toBe("my_data");
		expect(customEntry.data).toEqual({ foo: "bar" });
		expect(customEntry.id).toBe(customId);
		expect(customEntry.parentId).toBe(msgId);

		const path = session.getBranch();
		expect(path).toHaveLength(3);
		expect(path[0].id).toBe(msgId);
		expect(path[1].id).toBe(customId);
		expect(path[2].id).toBe(msg2Id);

		expect(session.buildSessionContext().messages).toHaveLength(2);
	});
});

describe("SessionManager context windows", () => {
	it("restores the active window without deleting earlier transcript entries", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-context-window-"));
		try {
			const session = SessionManager.create("/test/project", dir);
			session.appendMessage({ role: "user", content: "old request", timestamp: 1 });
			session.appendMessage(fauxAssistantMessage("old response"));
			const windowId = session.appendContextWindow("continue here", 1234);
			session.appendMessage({ role: "user", content: "new request", timestamp: 2 });

			const file = session.getSessionFile();
			expect(file).toBeDefined();
			const restored = SessionManager.open(file!, dir);

			expect(restored.getEntries()).toHaveLength(4);
			expect(restored.getEntry(windowId)?.type).toBe("context_window");
			expect(restored.buildSessionContext().messages.map((message) => message.role)).toEqual(["custom", "user"]);

			const forkFile = restored.createBranchedSession(restored.getLeafId()!);
			const fork = SessionManager.open(forkFile!, dir);
			expect(fork.getEntry(windowId)?.type).toBe("context_window");
			expect(fork.buildSessionContext().messages.map((message) => message.role)).toEqual(["custom", "user"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
