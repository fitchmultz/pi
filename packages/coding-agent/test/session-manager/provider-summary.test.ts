import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, JsonObject, SystemMessage, Tool, UserMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { estimateProjectedContextTokens, estimateTokens } from "../../src/core/compaction/compaction.ts";
import { type CompactionProviderSummary, SessionManager } from "../../src/core/session-manager.ts";

const block: JsonObject = { type: "compaction", content: "Read the task note.", signature: "EuYBCkQY" };
const written: CompactionProviderSummary = {
	provider: "anthropic",
	api: "anthropic-messages",
	model: "claude-test",
	block,
	seconds: 2.5,
};

function tool(name: string): Tool {
	return { name, description: name, parameters: { type: "object", properties: {} } };
}

function system(content: string, toolsAdded: Tool[]): SystemMessage {
	return { role: "system", content, toolsAdded, timestamp: 1 };
}

function user(text: string): UserMessage {
	return { role: "user", content: text, timestamp: 1 };
}

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

/** One line per message: the role, what a system message carries, and the text. */
function describeMessages(messages: AgentMessage[]): string[] {
	return messages.map((message) => {
		if (message.role === "system") {
			const added = message.toolsAdded?.map((entry) => entry.name).join(",");
			return `system${message.providerSummary ? "+block" : ""}${added ? ` +${added}` : ""}`;
		}
		if (message.role === "compactionSummary") return `summary: ${message.summary}`;
		if (message.role === "user") return `user: ${message.content}`;
		if (message.role === "assistant") {
			return `assistant: ${message.content.map((part) => (part.type === "text" ? part.text : "")).join("")}`;
		}
		return message.role;
	});
}

describe("SessionManager provider summary block", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-provider-summary-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	/** A session where `ring` is loaded before the first kept turn and `chime` after it. */
	function compactedSession(): { manager: SessionManager; compactionId: string; keptIds: string[] } {
		const manager = SessionManager.create(dir, dir);
		manager.appendMessage(system("prompt", [tool("lookup")]));
		manager.appendMessage(user("one"));
		manager.appendMessage(assistant("first"));
		manager.appendMessage(system("", [tool("ring")]));
		manager.appendMessage(user("two"));
		const keptIds = [
			manager.appendMessage(assistant("second")),
			manager.appendMessage(system("", [tool("chime")])),
			manager.appendMessage(user("three")),
			manager.appendMessage(assistant("third")),
		];
		const compactionId = manager.appendCompaction(
			"the summary",
			keptIds[0],
			1000,
			undefined,
			true,
			undefined,
			written,
		);
		return { manager, compactionId, keptIds };
	}

	it("keeps the leading system message and replays the kept entries between the block and the summary", () => {
		const { manager, compactionId, keptIds } = compactedSession();
		const afterId = manager.appendMessage(user("four"));

		const entry = manager.getEntry(compactionId);
		if (entry?.type !== "compaction") throw new Error("expected compaction");
		expect(entry.systemMessage).toEqual(system("prompt", [tool("lookup")]));
		expect(entry.providerSummary).toEqual({ ...written, toolsAdded: [tool("ring")] });

		const expected = [
			"system+block +lookup",
			"system +ring",
			"assistant: second",
			"system +chime",
			"user: three",
			"assistant: third",
			"summary: the summary",
			"user: four",
		];
		const projection = manager.buildSessionProjection();
		expect(describeMessages(projection.messages)).toEqual(expected);
		expect(projection.messages[0]).toEqual({
			...system("prompt", [tool("lookup")]),
			providerSummary: {
				provider: "anthropic",
				api: "anthropic-messages",
				model: "claude-test",
				block,
				timestamp: new Date(entry.timestamp).getTime(),
			},
		});
		// Callers that list the context entries get the compaction once.
		expect(manager.buildContextEntries().map((contextEntry) => contextEntry.id)).toEqual([
			compactionId,
			...keptIds,
			afterId,
		]);

		const file = manager.getSessionFile();
		if (!file) throw new Error("expected a session file");
		expect(describeMessages(SessionManager.open(file).buildSessionProjection().messages)).toEqual(expected);
		const fork = SessionManager.forkFrom(file, join(dir, "fork"), join(dir, "fork"));
		expect(describeMessages(fork.buildSessionProjection().messages)).toEqual(expected);
	});

	it("keeps the summary of an earlier block where the kept turns of the next block followed it", () => {
		const { manager, keptIds } = compactedSession();
		manager.appendMessage(user("four"));
		manager.appendMessage(assistant("fourth"));
		manager.appendCompaction("the second summary", keptIds[3], 1000, undefined, true, undefined, {
			...written,
			block: { ...block, content: "Second." },
		});

		const projection = manager.buildSessionProjection();
		expect(describeMessages(projection.messages)).toEqual([
			"system+block +lookup",
			// Both tools were loaded before the first kept turn of this block.
			"system +ring,chime",
			"assistant: third",
			"summary: the summary",
			"user: four",
			"assistant: fourth",
			"summary: the second summary",
		]);
		expect(projection.messages[0]).toMatchObject({ providerSummary: { block: { content: "Second." } } });
	});

	it("stores a later compaction without a block as any other: the first tool list, then the tools loaded since", () => {
		const { manager } = compactedSession();
		const keptId = manager.appendMessage(user("four"));
		manager.appendCompaction("plain summary", keptId, 1000, undefined, true, undefined, {
			provider: "anthropic",
			api: "anthropic-messages",
			model: "claude-test",
			reason: "cut",
			seconds: 0,
		});

		// The earlier block no longer leads the context, and its tools are not folded into a new list.
		expect(describeMessages(manager.buildSessionProjection().messages)).toEqual([
			"system +lookup",
			"system +ring,chime",
			"summary: plain summary",
			"user: four",
		]);
	});

	it("preserves cacheIdentity and projects outputTokens into context estimates across disk resume", () => {
		const manager = SessionManager.create(dir, dir);
		manager.appendMessage(system("prompt", [tool("lookup")]));
		manager.appendMessage(user("one"));
		const keptId = manager.appendMessage(assistant("kept"));
		const encryptedBlock: JsonObject = { type: "compaction", id: "cmp_1", encrypted_content: "enc" };
		manager.appendCompaction("handoff", keptId, 50_000, undefined, true, undefined, {
			provider: "chatgpt-rotate",
			api: "openai-responses",
			model: "gpt-6.2-sol",
			block: encryptedBlock,
			cacheIdentity: "work-account-hash",
			seconds: 4.2,
			usage: {
				input: 1000,
				output: 2_500,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 3_500,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});

		const file = manager.getSessionFile();
		if (!file) throw new Error("expected a session file");
		const reopenedManager = SessionManager.open(file);
		const reopened = reopenedManager.buildSessionProjection();
		const lead = reopened.messages[0] as SystemMessage;
		expect(lead.providerSummary).toMatchObject({
			provider: "chatgpt-rotate",
			api: "openai-responses",
			model: "gpt-6.2-sol",
			block: encryptedBlock,
			cacheIdentity: "work-account-hash",
			outputTokens: 2_500,
		});

		const withoutOutputLead: SystemMessage = {
			...lead,
			providerSummary: { ...lead.providerSummary!, outputTokens: undefined },
		};
		const withoutOutput = {
			...reopened,
			messages: [withoutOutputLead, ...reopened.messages.slice(1)],
		};
		expect(estimateTokens(lead)).toBe(estimateTokens(withoutOutputLead) + 2_500);
		expect(estimateProjectedContextTokens(reopened, reopenedManager.getBranch()).tokens).toBe(
			estimateProjectedContextTokens(withoutOutput, reopenedManager.getBranch()).tokens + 2_500,
		);
	});
});
