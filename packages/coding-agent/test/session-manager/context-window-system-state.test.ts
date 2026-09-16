import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { parseSessionEntries, SessionManager } from "../../src/core/session-manager.ts";

it("retains current prompt and tools across a persisted context window without retaining conversation", () => {
	const manager = SessionManager.inMemory("/workspace");
	manager.appendMessage({
		role: "system",
		content: "Runtime guidance",
		sections: { rules: "Original rules" },
		toolsAdded: [{ name: "original", description: "Original tool", parameters: Type.Object({}) }],
		timestamp: 1,
	});
	manager.appendMessage({ role: "user", content: "Old conversation", timestamp: 2 });
	manager.appendMessage({
		role: "system",
		content: "",
		sections: { rules: "Updated rules" },
		toolsRemoved: [{ name: "original" }],
		toolsAdded: [{ name: "chosen", description: "Selected tool", parameters: Type.Object({}) }],
		timestamp: 3,
	});
	manager.appendContextWindow("Continue the task", 100);
	manager.appendMessage({ role: "user", content: "New conversation", timestamp: 4 });

	const serialized = [manager.getHeader(), ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n");
	const reopened = SessionManager.inMemory("/workspace", undefined, parseSessionEntries(serialized));
	const messages = reopened.buildSessionContext().messages;

	expect(messages.map((message) => message.role)).toEqual(["system", "custom", "user"]);
	expect(getCurrentSystemPrompt(messages)).toBe("Runtime guidance\n\nUpdated rules");
	expect(getCurrentTools(messages).map((tool) => tool.name)).toEqual(["chosen"]);
	expect(messages[1]).toMatchObject({
		customType: "context-window",
		content: expect.stringContaining("Continue the task"),
	});
	expect(messages[2]).toMatchObject({ content: "New conversation" });
	expect(reopened.getEntries()).toEqual(manager.getEntries());
});
