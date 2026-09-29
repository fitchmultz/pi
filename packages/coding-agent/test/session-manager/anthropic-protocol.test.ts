import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, type Model, normalizeContext } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stream } from "../../../ai/src/api/anthropic-messages.ts";
import { convertToLlm } from "../../src/core/messages.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

beforeEach(() => vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-09-22T00:00:00Z") }));
afterEach(() => vi.useRealTimers());

const inline = "inline-tools-2026-09-15";
const reference = "mid-conversation-tool-changes-2026-07-01";
const model: Model<"anthropic-messages"> = {
	id: "fixture",
	name: "Fixture",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	contextWindow: 10000,
	maxTokens: 100,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true },
};

async function capture(session: SessionManager, beta?: string) {
	let headers = new Headers();
	const response = await stream(
		model,
		normalizeContext({ messages: convertToLlm(session.buildSessionContext().messages) }),
		{
			apiKey: "offline",
			maxRetries: 0,
			headers: beta ? { "anthropic-beta": beta } : undefined,
			fetch: async (_url, init) => {
				headers = new Headers(init?.headers);
				expect(String(init?.body)).not.toContain("anthropic_tool_protocol");
				expect(String(init?.body)).not.toContain("windowTimestamp");
				const events = [
					{
						type: "message_start",
						message: { id: randomUUID(), model: model.id, usage: { input_tokens: 1, output_tokens: 0 } },
					},
					{ type: "content_block_start", index: 0, content_block: { type: "text", text: "Done" } },
					{ type: "content_block_stop", index: 0 },
					{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
					{ type: "message_stop" },
				];
				return new Response(
					events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
					{
						headers: { "content-type": "text/event-stream" },
					},
				);
			},
		},
	).result();
	expect(response.stopReason).toBe("stop");
	return { response, beta: headers.get("anthropic-beta") };
}

it("keeps projection without system state unchanged and retains the inherited protocol across requests", async () => {
	const session = SessionManager.inMemory();
	session.appendMessage({ role: "user", content: "Legacy", timestamp: 1 });
	const inherited = {
		...fauxAssistantMessage("Earlier response"),
		api: model.api,
		provider: model.provider,
		model: model.id,
		diagnostics: [
			{
				type: "anthropic_tool_protocol",
				timestamp: 2,
				details: { beta: reference, inline: false, windowTimestamp: 0, baseUrl: model.baseUrl },
			},
		],
	};
	const responseId = session.appendMessage(inherited);
	session.appendCompaction("Legacy summary", responseId, 100);
	const before = session.buildSessionContext().messages;
	expect(before.map((message) => message.role)).toEqual(["compactionSummary", "assistant"]);
	expect(before[1]).toEqual(inherited);
	const first = await capture(session);
	expect(first.beta).toContain(reference);
	expect(session.buildSessionContext().messages).toEqual(before);
	session.appendMessage(first.response);
	const next = await capture(session, inline);
	expect(next.beta).toBe(first.beta);
	expect(session.buildSessionContext().messages.some((message) => message.role === "system")).toBe(false);
});

it("reselects protocol when compaction retains a response from the same millisecond", async () => {
	const session = SessionManager.inMemory();
	session.appendMessage({ role: "system", content: "Base", timestamp: Date.now() });
	session.appendMessage({ role: "user", content: "Hello", timestamp: Date.now() });
	const first = await capture(session, inline);
	expect(first.beta).toContain(inline);
	const responseId = session.appendMessage(first.response);
	session.appendCompaction("Rebuilt prefix", responseId, 100);
	const next = await capture(session, reference);
	expect(next.beta).toContain(reference);
	session.appendMessage(next.response);
	expect((await capture(session, inline)).beta).toContain(reference);
});

it.each(["legacy", "reference", "inline"] as const)(
	"binds %s protocol across persisted resume/fork, and reselects at compaction",
	async (mode) => {
		const dir = mkdtempSync(join(tmpdir(), "pi-anthropic-window-"));
		try {
			const session = SessionManager.create(dir, dir);
			session.appendMessage({
				role: "system",
				content: "Base",
				toolsAdded: [{ name: "lookup", description: "Lookup", parameters: { type: "object", properties: {} } }],
				timestamp: 0,
			});
			session.appendMessage({ role: "user", content: "Hello", timestamp: 1 });
			const first =
				mode === "legacy"
					? {
							...fauxAssistantMessage("Legacy"),
							api: model.api,
							provider: model.provider,
							model: model.id,
							timestamp: 2,
						}
					: (await capture(session, mode === "reference" ? reference : undefined)).response;
			const firstId = session.appendMessage(first);
			const expected = mode === "inline" ? inline : reference;
			const opposite = mode === "inline" ? reference : inline;
			const restored = SessionManager.open(session.getSessionFile()!, dir);
			expect((await capture(restored, opposite)).beta).toContain(expected);
			const fork = SessionManager.forkFrom(restored.getSessionFile()!, dir, dir);
			expect((await capture(fork, opposite)).beta).toContain(expected);
			// Compaction retains the old response, but establishes a distinct prefix identity.
			vi.setSystemTime(Date.now() + 1000);
			fork.appendCompaction("Summary", firstId, 100);
			const compacted = fork.buildSessionContext().messages;
			expect(compacted.some((message) => message.role === "assistant")).toBe(true);
			expect(compacted.find((message) => message.role === "system")).toMatchObject({ timestamp: Date.now() });
			const afterCompaction = await capture(fork);
			expect(afterCompaction.beta).toContain(inline);
			expect(afterCompaction.response.diagnostics).toContainEqual(
				expect.objectContaining({
					type: "anthropic_tool_protocol",
					details: expect.objectContaining({ windowTimestamp: Date.now(), baseUrl: model.baseUrl }),
				}),
			);
			fork.appendMessage(afterCompaction.response);
			const resumedWindow = SessionManager.open(fork.getSessionFile()!, dir);
			expect((await capture(resumedWindow, reference)).beta).toContain(inline);
			vi.setSystemTime(Date.now() + 1000);
			resumedWindow.appendCompaction("Fresh", null, 100);
			const fresh = await capture(resumedWindow, reference);
			expect(fresh.beta).toContain(reference);
			resumedWindow.appendMessage(fresh.response);
			expect((await capture(resumedWindow, inline)).beta).toContain(reference);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	},
);
