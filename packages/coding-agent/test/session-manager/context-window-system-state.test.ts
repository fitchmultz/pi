import { fauxAssistantMessage, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS, prepareCompaction } from "../../src/core/compaction/index.ts";
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

it("omits a retained window's checkpoint without changing its saved state", () => {
	const manager = SessionManager.inMemory("/workspace");
	manager.appendMessage({ role: "system", content: "BASE PROMPT", timestamp: 1 });
	const window = manager.appendContextWindow("Continue here", 100);
	manager.appendMessage({ role: "user", content: "new input", timestamp: 2 });
	manager.appendCompaction("summary", window, 100);
	const messages = manager.buildSessionContext().messages;
	expect(messages.map((message) => message.role)).toEqual(["system", "compactionSummary", "custom", "user"]);
	expect(getCurrentSystemPrompt(messages)).toBe("BASE PROMPT");
	manager.branch(window);
	expect(getCurrentSystemPrompt(manager.buildSessionContext().messages)).toBe("BASE PROMPT");
});

it("replays only the active checkpoint when repeated compaction splits a previously retained turn", () => {
	const manager = SessionManager.inMemory("/workspace");
	const original = { name: "original", description: "Original tool", parameters: Type.Object({}) };
	const chosen = { name: "chosen", description: "Selected tool", parameters: Type.Object({}) };
	manager.appendMessage({
		role: "system",
		content: "BASE PROMPT",
		sections: { rules: "Original rules", obsolete: "Remove me" },
		toolsAdded: [original],
		timestamp: 1,
	});
	manager.appendMessage({ role: "user", content: "first", timestamp: 2 });
	manager.appendMessage(fauxAssistantMessage("first answer"));
	const keptUser = manager.appendMessage({ role: "user", content: "x".repeat(4000), timestamp: 3 });
	const keptAssistant = manager.appendMessage(fauxAssistantMessage("y".repeat(200_000)));
	const firstCompaction = manager.appendCompaction("summary one", keptUser, 100_000);
	manager.appendMessage({
		role: "system",
		content: "ADDED GUIDANCE",
		sections: { rules: "Updated rules", obsolete: null },
		toolsRemoved: [{ name: original.name }],
		toolsAdded: [chosen],
		timestamp: 4,
	});
	manager.appendMessage({ role: "user", content: "third", timestamp: 5 });
	manager.appendMessage(fauxAssistantMessage("third answer"));
	const preparation = prepareCompaction(manager.getBranch(), DEFAULT_COMPACTION_SETTINGS)!;
	expect(preparation.isSplitTurn).toBe(true);
	expect(preparation.firstKeptEntryId).toBe(keptAssistant);
	manager.appendCompaction("summary two", preparation.firstKeptEntryId, preparation.tokensBefore);
	const entriesBeforeProjection = JSON.stringify(manager.getEntries());
	const messages = manager.buildSessionContext().messages;
	expect(getCurrentSystemPrompt(messages)).toBe("BASE PROMPT\n\nADDED GUIDANCE\n\nUpdated rules");
	expect(getCurrentTools(messages)).toEqual([chosen]);
	expect(messages.filter((message) => message.role === "system")).toHaveLength(1);
	// Canonical projection sends only the newest summary. Older checkpoints remain
	// unchanged in raw history and are restored when navigating back to that branch point.
	expect(messages.filter((message) => message.role === "compactionSummary")).toEqual([
		expect.objectContaining({ summary: "summary two" }),
	]);
	const rawFirstCompaction = manager.getEntry(firstCompaction);
	expect(manager.buildContextEntries().find((entry) => entry.id === firstCompaction)).toBe(rawFirstCompaction);
	expect(manager.buildSessionProjection().entries.find((entry) => entry.sourceEntry.id === firstCompaction)).toEqual({
		sourceEntry: rawFirstCompaction,
		messages: [],
	});
	expect(rawFirstCompaction).toMatchObject({
		type: "compaction",
		summary: "summary one",
		systemMessage: { toolsAdded: [original] },
	});
	expect(JSON.stringify(manager.getEntries())).toBe(entriesBeforeProjection);

	// Later deltas still apply exactly once, including after serialization and another boundary.
	manager.appendMessage({
		role: "system",
		content: "LATEST GUIDANCE",
		sections: { rules: "Latest rules" },
		toolsRemoved: [{ name: chosen.name }],
		toolsAdded: [original],
		timestamp: 6,
	});
	const serialized = [manager.getHeader(), ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n");
	const reopened = SessionManager.inMemory("/workspace", undefined, parseSessionEntries(serialized));
	for (const current of [manager, reopened]) {
		expect(getCurrentSystemPrompt(current.buildSessionContext().messages)).toBe(
			"BASE PROMPT\n\nADDED GUIDANCE\n\nLATEST GUIDANCE\n\nLatest rules",
		);
		expect(getCurrentTools(current.buildSessionContext().messages)).toEqual([original]);
		current.appendContextWindow("continue", 100);
		expect(getCurrentSystemPrompt(current.buildSessionContext().messages)).toBe(
			"BASE PROMPT\n\nADDED GUIDANCE\n\nLATEST GUIDANCE\n\nLatest rules",
		);
		current.branch(firstCompaction);
		expect(getCurrentSystemPrompt(current.buildSessionContext().messages)).toBe(
			"BASE PROMPT\n\nOriginal rules\n\nRemove me",
		);
		expect(getCurrentTools(current.buildSessionContext().messages)).toEqual([original]);
	}
});
