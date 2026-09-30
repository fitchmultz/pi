import { execFile, execFileSync } from "node:child_process";
import {
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { convertResponsesMessages } from "../../ai/src/api/openai-responses-shared.ts";
import { transformMessages } from "../../ai/src/api/transform-messages.ts";
import { normalizeContext } from "../../ai/src/compat.ts";
import type { Model } from "../../ai/src/types.ts";
import { convertToLlm } from "../src/core/messages.ts";
import { assertSessionConversionNotRequired, convertSessionFile } from "../src/core/session-conversion.ts";
import { buildSessionContext, type SessionEntry } from "../src/core/session-manager.ts";

type Entry = Record<string, unknown>;
const timestamp = "2026-09-01T00:00:00.000Z";
const header = { type: "session", version: 3, id: "archive", cwd: "/tmp", timestamp };
const usage = {
	input: 5,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 7,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function entry(id: string, parentId: string | null, fields: Entry): Entry {
	return { id, parentId, timestamp, ...fields };
}
function assistant(content: unknown[], extra: Entry = {}): Entry {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "test",
		responseId: "response",
		stopReason: "toolUse",
		usage,
		timestamp: 0,
		...extra,
	};
}
const call = {
	type: "toolCall",
	id: "call",
	name: "lookup",
	namespace: "docs",
	arguments: { query: "example" },
	async: true,
	executionStarted: true,
};
function settled(): Entry[] {
	return [
		entry("system", null, {
			type: "message",
			message: {
				role: "system",
				content: "instructions",
				timestamp: 0,
				nativeHead: true,
				toolsAdded: [
					{
						name: "lookup",
						namespace: "docs",
						async: true,
						description: "Find facts",
						parameters: { type: "object" },
					},
				],
			},
		}),
		entry("snapshot", "system", {
			type: "message",
			checkpoint: true,
			message: assistant([call], { stopReason: "pending" }),
		}),
		entry("result", "snapshot", {
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "call",
				toolName: "lookup",
				namespace: "docs",
				content: [{ type: "text", text: "final result" }],
				isError: false,
				timestamp: 1,
			},
		}),
		entry("final", "result", {
			type: "message",
			message: assistant([call, { type: "text", text: "completed response" }], {
				diagnostics: [{ type: "test", message: "safe diagnostic" }],
			}),
		}),
	];
}
const directories: string[] = [];
function fixture(entries: Entry[]) {
	const directory = mkdtempSync(join(tmpdir(), "pi-conversion-"));
	directories.push(directory);
	const source = join(directory, "original.jsonl");
	const output = join(directory, "converted.jsonl");
	const bytes = `${[header, ...entries].map((item) => JSON.stringify(item)).join("\n")}\n`;
	writeFileSync(source, bytes);
	return { directory, source, output, bytes };
}
function convertedEntries(path: string): SessionEntry[] {
	const entries = readFileSync(path, "utf8")
		.trimEnd()
		.split("\n")
		.slice(1)
		.map((line) => JSON.parse(line) as SessionEntry);
	const seen = new Set<string>();
	for (const item of entries) {
		expect(item.parentId === null || seen.has(item.parentId)).toBe(true);
		expect(seen.has(item.id)).toBe(false);
		seen.add(item.id);
	}
	return entries;
}
const model: Model<"openai-responses"> = {
	id: "test",
	name: "test",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://invalid.local",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 1_000,
};
function providerReplay(entries: SessionEntry[], expectedIds: string[], leaf?: string) {
	const messages = transformMessages(convertToLlm(buildSessionContext(entries, leaf).messages), model);
	expect(messages.filter((message) => message.role === "toolResult").map((message) => message.toolCallId)).toEqual(
		expectedIds,
	);
	let pending = new Set<string>();
	for (const message of messages) {
		if (message.role === "assistant" || message.role === "user") {
			expect([...pending]).toEqual([]);
			pending = new Set(
				message.role === "assistant"
					? message.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : []))
					: [],
			);
		}
		if (message.role === "toolResult") expect(pending.delete(message.toolCallId)).toBe(true);
	}
	expect([...pending]).toEqual([]);
	return messages;
}
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("one-time session conversion", () => {
	it("preserves the archive and completed results while collapsing execution snapshots into upstream context", () => {
		const { source, output, bytes } = fixture(settled());
		convertSessionFile(source, output);
		expect(readFileSync(source, "utf8")).toBe(bytes);
		const entries = convertedEntries(output);
		expect(() => assertSessionConversionNotRequired(entries)).not.toThrow();
		const context = buildSessionContext(entries);
		expect(context.messages.map((message) => message.role)).toEqual(["system", "assistant", "toolResult"]);
		expect(context.messages[0]).toMatchObject({ toolsAdded: [{ name: "lookup" }] });
		expect(context.messages[1]).toMatchObject({
			content: [
				{ type: "toolCall", id: "call", name: "lookup" },
				{ type: "text", text: "completed response" },
			],
			usage,
			diagnostics: [{ type: "test", message: "safe diagnostic" }],
		});
		expect(context.messages[2]).toMatchObject({ content: [{ type: "text", text: "final result" }] });
		expect(JSON.stringify(context.messages)).not.toContain('"executionStarted"');
		expect(JSON.stringify(context.messages)).not.toContain('"namespace"');
		expect(entries).toContainEqual(
			expect.objectContaining({
				type: "custom",
				customType: "legacy-conversion-metadata",
				data: { sourceEntryId: "system", system: { nativeHead: true } },
			}),
		);
	});

	it("reads the blank separators written by the fork append path without changing the original", () => {
		const { source, output, bytes } = fixture(settled());
		// Fork SessionManager._persist appends `\n${JSON.stringify(entry)}\n`.
		const framed = bytes.replaceAll("\n{", "\n\n{");
		writeFileSync(source, framed);
		convertSessionFile(source, output);
		expect(readFileSync(source, "utf8")).toBe(framed);
		expect(buildSessionContext(convertedEntries(output)).messages.map((message) => message.role)).toEqual([
			"system",
			"assistant",
			"toolResult",
		]);
	});

	it("preserves supported hosted web-search metadata on assistant responses", () => {
		const input = settled();
		const webSearch = { calls: [], citations: [] };
		(input[3].message as Entry).webSearch = webSearch;
		const { source, output } = fixture(input);
		convertSessionFile(source, output);
		expect(buildSessionContext(convertedEntries(output)).messages[1]).toMatchObject({ webSearch });
	});

	it("keeps differing API response identities separate with their original billing", () => {
		const input = [
			entry("responses", null, {
				type: "message",
				message: assistant([{ type: "text", text: "responses output" }], { stopReason: "stop" }),
			}),
			entry("completions", "responses", {
				type: "message",
				message: assistant([{ type: "text", text: "completions output" }], {
					api: "openai-completions",
					stopReason: "stop",
				}),
			}),
		];
		const { source, output, bytes } = fixture(input);
		convertSessionFile(source, output);
		const entries = convertedEntries(output);
		expect(providerReplay(entries, []).map((message) => message.content)).toEqual([
			[{ type: "text", text: "responses output" }],
			[{ type: "text", text: "completions output" }],
		]);
		expect(entries.filter((item) => item.type === "message").map((item) => item.message)).toEqual(
			input.map((item) => item.message),
		);
		expect(readFileSync(source, "utf8")).toBe(bytes);
	});

	it.each(["error", "aborted"])(
		"replays only committed signed output from an %s response without changing its failure or billing",
		(stopReason) => {
			const reasoning = {
				type: "thinking",
				thinking: "completed reasoning",
				thinkingSignature: JSON.stringify({ type: "reasoning", id: "rs_done", summary: [], status: "completed" }),
			};
			const committedCall = {
				...call,
				id: "call|fc_done",
				executionStarted: undefined,
				executionArguments: { query: "preflight-adjusted arguments" },
				responsesItem: {
					type: "function_call",
					id: "fc_done",
					call_id: "call",
					name: "lookup",
					namespace: "docs",
					arguments: JSON.stringify(call.arguments),
					status: "completed",
				},
			};
			const original = assistant(
				[
					reasoning,
					{ type: "text", text: "completed text", textSignature: "msg_done" },
					committedCall,
					{
						type: "thinking",
						thinking: "interrupted suffix",
						thinkingSignature: JSON.stringify({
							type: "reasoning",
							id: "rs_tail",
							summary: [],
							status: "in_progress",
						}),
					},
					{ type: "text", text: "unsigned partial" },
				],
				{ stopReason, errorMessage: "original failure", toolExecutionFailed: true },
			);
			const input = [
				entry("failed", null, { type: "message", message: original }),
				entry("result", "failed", {
					type: "message",
					message: { ...(settled()[2].message as Entry), toolCallId: "call|fc_done", usage },
				}),
			];
			const { source, output, bytes } = fixture(input);
			convertSessionFile(source, output);
			const entries = convertedEntries(output);
			expect(entries.find((item) => item.id === "failed")).toMatchObject({
				message: { stopReason, errorMessage: "original failure", usage },
			});
			expect(entries).toContainEqual(
				expect.objectContaining({
					customType: "legacy-conversion-metadata",
					data: expect.objectContaining({ sourceEntryId: "failed", originalSnapshot: input[0] }),
				}),
			);
			const replay = providerReplay(entries, ["call|fc_done"]);
			expect(replay[0]).toMatchObject({
				stopReason: "toolUse",
				usage: { totalTokens: 0, cost: { total: 0 } },
			});
			expect(replay[0]).not.toHaveProperty("errorMessage");
			const wire = convertResponsesMessages(
				model,
				normalizeContext({ messages: convertToLlm(buildSessionContext(entries).messages) }),
				new Set(["openai"]),
			);
			expect(wire.map((item) => item.type)).toEqual([
				"reasoning",
				"message",
				"function_call",
				"function_call_output",
			]);
			expect(wire[0]).toEqual(JSON.parse(reasoning.thinkingSignature));
			expect(wire[1]).toMatchObject({ id: "msg_done", content: [{ text: "completed text" }] });
			expect(wire[2]).toMatchObject({ id: "fc_done", call_id: "call", arguments: JSON.stringify(call.arguments) });
			expect(wire[3]).toMatchObject({ call_id: "call", output: "final result" });
			expect(
				entries.reduce(
					(total, item) =>
						total +
						(item.type === "message" && item.message.role === "assistant" ? item.message.usage.totalTokens : 0),
					0,
				),
			).toBe(7);
			expect(readFileSync(source, "utf8")).toBe(bytes);
		},
	);

	it.each(["error", "aborted"])("keeps native skip behavior for a call-free %s response", (stopReason) => {
		const original = assistant([{ type: "text", text: "partial output" }], {
			stopReason,
			errorMessage: "original failure",
		});
		const { source, output, bytes } = fixture([entry("failed", null, { type: "message", message: original })]);
		convertSessionFile(source, output);
		const entries = convertedEntries(output);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ id: "failed", message: original });
		expect(providerReplay(entries, [])).toEqual([]);
		expect(readFileSync(source, "utf8")).toBe(bytes);
	});

	it.each(["uncommitted", "malformed item"])("refuses interrupted calls with %s proof before publication", (kind) => {
		const input = settled();
		const interruptedCall = {
			...call,
			executionStarted: false,
			...(kind === "malformed item" ? { responsesItem: { type: "function_call", call_id: "wrong" } } : {}),
		};
		(input[1].message as Entry).content = [interruptedCall];
		(input[3].message as Entry).content = [interruptedCall];
		(input[3].message as Entry).stopReason = "aborted";
		const { source, output, bytes } = fixture(input);
		expect(() => convertSessionFile(source, output)).toThrow(/committed/);
		expect(existsSync(output)).toBe(false);
		expect(readFileSync(source, "utf8")).toBe(bytes);
	});

	it("normalizes legacy string tool removals into upstream references", () => {
		const input = settled();
		(input[0].message as Entry).toolsRemoved = ["retired"];
		const { source, output } = fixture(input);
		convertSessionFile(source, output);
		expect(buildSessionContext(convertedEntries(output)).messages[0]).toMatchObject({
			toolsRemoved: [{ name: "retired" }],
		});
	});

	it("accepts root branch-summary references and checks every branch", () => {
		const input = settled();
		input.push(entry("root-summary", null, { type: "branch_summary", fromId: "root", summary: "fresh start" }));
		input.push(
			entry("root-user", "root-summary", {
				type: "message",
				message: { role: "user", content: "new", timestamp: 4 },
			}),
		);
		const { source, output, bytes } = fixture(input);
		convertSessionFile(source, output);
		expect(readFileSync(source, "utf8")).toBe(bytes);
		expect(
			buildSessionContext(convertedEntries(output), "root-user").messages.map((message) => message.role),
		).toEqual(["branchSummary", "user"]);
	});

	it.each(["adjacent", "system", "late"])("keeps branch-local receipts distinct when %s", (arrival) => {
		const input = [entry("calling", null, { type: "message", message: assistant([call]) })];
		for (const branch of ["a", "b"]) {
			if (arrival === "system")
				input.push(
					entry(`${branch}-system`, "calling", {
						type: "message",
						message: {
							role: "system",
							content: `instructions ${branch}`,
							timestamp: 1,
							toolsAdded: [{ name: `added_${branch}`, description: "Branch tool", parameters: {} }],
						},
					}),
				);
			const user = entry(`${branch}-user`, arrival === "late" ? "calling" : `${branch}-result`, {
				type: "message",
				message: { role: "user", content: `input ${branch}`, timestamp: 2 },
			});
			const result = entry(
				`${branch}-result`,
				arrival === "late" ? `${branch}-user` : arrival === "system" ? `${branch}-system` : "calling",
				{
					type: "message",
					message: { ...(settled()[2].message as Entry), content: [{ type: "text", text: `receipt ${branch}` }] },
				},
			);
			input.push(...(arrival === "late" ? [user, result] : [result, user]));
		}
		const { source, output, bytes } = fixture(input);
		if (arrival === "late") {
			expect(() => convertSessionFile(source, output)).toThrow(/branch-dependent native receipt relocation/);
			expect(existsSync(output)).toBe(false);
		} else {
			convertSessionFile(source, output);
			const entries = convertedEntries(output);
			for (const branch of ["a", "b"]) {
				const replay = providerReplay(entries, ["call"], `${branch}-user`);
				expect(replay[1]).toMatchObject({ content: [{ type: "text", text: `receipt ${branch}` }] });
				expect(replay.at(-1)).toMatchObject({ role: "user", content: `input ${branch}` });
				if (arrival === "system") {
					expect(replay[2]).toMatchObject({ role: "system", content: `instructions ${branch}` });
					expect(
						getCurrentTools(buildSessionContext(entries, `${branch}-user`).messages).map((tool) => tool.name),
					).toEqual([`added_${branch}`]);
					expect(entries.find((item) => item.id === `${branch}-system`)).toMatchObject({ parentId: "calling" });
				}
			}
			expect(entries.map((item) => item.id)).toEqual(expect.arrayContaining(input.map((item) => item.id)));
		}
		expect(readFileSync(source, "utf8")).toBe(bytes);
	});

	it.each(["before", "after"])(
		"carries receipts completed %s a fresh window without old prose or double billing",
		(arrival) => {
			const input = settled();
			if (arrival === "before")
				input.push(
					entry("window", "final", {
						type: "context_window",
						tokensBefore: 20,
						handoff: "continue with the receipt",
						retainedToolResultIds: ["result"],
					}),
				);
			else {
				input.splice(
					2,
					0,
					entry("window", "snapshot", {
						type: "context_window",
						tokensBefore: 20,
						handoff: "continue with the receipt",
					}),
				);
				input[3].parentId = "window";
			}
			const { source, output } = fixture(input);
			convertSessionFile(source, output);
			const entries = convertedEntries(output);
			const context = buildSessionContext(entries);
			expect(context.messages.map((message) => message.role)).toEqual([
				"compactionSummary",
				"assistant",
				"toolResult",
			]);
			expect(context.messages[1]).toMatchObject({ content: [{ type: "toolCall", id: "call", name: "lookup" }] });
			expect(context.messages[2]).toMatchObject({ content: [{ type: "text", text: "final result" }] });
			providerReplay(entries, ["call"]);
			expect(JSON.stringify(context.messages)).not.toContain("completed response");
			const total = entries.reduce(
				(sum, item) =>
					sum +
					(item.type === "message" && item.message.role === "assistant" ? item.message.usage.totalTokens : 0),
				0,
			);
			expect(total).toBe(7);
			expect(() => assertSessionConversionNotRequired(entries)).not.toThrow();
		},
	);

	it.each(["before", "after"])(
		"pairs multiple carried response groups with receipts arriving %s a window",
		(arrival) => {
			const first = assistant([call], { responseId: "first" });
			const second = assistant([{ ...call, id: "second-call" }], {
				responseId: "second",
				stopReason: "error",
				errorMessage: "interrupted",
			});
			const input = [
				entry("first", null, { type: "message", message: first }),
				entry("second", "first", { type: "message", message: second }),
				entry("first-result", "second", {
					type: "message",
					message: { ...(settled()[2].message as Entry), usage },
				}),
				entry("second-result", "first-result", {
					type: "message",
					message: {
						...(settled()[2].message as Entry),
						toolCallId: "second-call",
						usage,
						content: [{ type: "text", text: "second receipt" }],
					},
				}),
			];
			if (arrival === "before")
				input.push(
					entry("window", "second-result", {
						type: "context_window",
						tokensBefore: 20,
						retainedToolResultIds: ["first-result", "second-result"],
					}),
				);
			else {
				input.splice(2, 0, entry("window", "second", { type: "context_window", tokensBefore: 20 }));
				input[3].parentId = "window";
			}
			const { source, output, bytes } = fixture(input);
			convertSessionFile(source, output);
			const entries = convertedEntries(output);
			const replay = providerReplay(entries, ["call", "second-call"]);
			expect(replay.map((message) => message.role)).toEqual([
				"user",
				"assistant",
				"toolResult",
				"assistant",
				"toolResult",
			]);
			expect(replay[2]).toMatchObject({ content: [{ type: "text", text: "final result" }] });
			expect(replay[4]).toMatchObject({ content: [{ type: "text", text: "second receipt" }] });
			expect(entries.find((item) => item.id === "second")).toMatchObject({
				message: { stopReason: "error", errorMessage: "interrupted", usage },
			});
			expect(
				entries.reduce(
					(total, item) =>
						total +
						(item.type === "message" && (item.message.role === "assistant" || item.message.role === "toolResult")
							? (item.message.usage?.totalTokens ?? 0)
							: 0),
					0,
				),
			).toBe(28);
			expect(readFileSync(source, "utf8")).toBe(bytes);
		},
	);

	it("retains coalesced calls and receipts when a compaction anchors its final snapshot", () => {
		const input = settled();
		input.push(
			entry("compact", "final", {
				type: "compaction",
				summary: "earlier summary",
				tokensBefore: 20,
				firstKeptEntryId: "final",
			}),
		);
		const { source, output } = fixture(input);
		convertSessionFile(source, output);
		const context = buildSessionContext(convertedEntries(output));
		expect(context.messages.map((message) => message.role)).toEqual(["compactionSummary", "assistant", "toolResult"]);
		expect(context.messages[2]).toMatchObject({ content: [{ type: "text", text: "final result" }] });
	});

	it("retains calls and later context across compaction at the chronological receipt leaf", () => {
		const input = settled();
		input.splice(
			2,
			0,
			entry("compact", "snapshot", {
				type: "compaction",
				summary: "earlier summary",
				tokensBefore: 20,
				firstKeptEntryId: "snapshot",
			}),
		);
		input[3].parentId = "compact";
		input.push(
			entry("later", "final", {
				type: "message",
				concurrentToolResultIds: ["result"],
				message: assistant([{ type: "text", text: "later response" }], { responseId: "later", stopReason: "stop" }),
			}),
		);
		const { source, output, bytes } = fixture(input);
		convertSessionFile(source, output);
		const entries = convertedEntries(output);
		const replay = providerReplay(entries, ["call"]);
		const context = buildSessionContext(entries);
		expect(context.messages.map((message) => message.role)).toEqual([
			"compactionSummary",
			"assistant",
			"toolResult",
			"assistant",
		]);
		expect(context.messages[1]).toMatchObject({
			content: [
				{ type: "toolCall", id: "call", name: "lookup", arguments: { query: "example" } },
				{ type: "text", text: "completed response" },
			],
		});
		expect(context.messages[3]).toMatchObject({ content: [{ type: "text", text: "later response" }] });
		expect(context.messages[2]).toMatchObject({
			toolCallId: "call",
			content: [{ type: "text", text: "final result" }],
		});
		expect(entries.at(-1)).toMatchObject({
			type: "custom",
			customType: "legacy-conversion-metadata",
			data: expect.objectContaining({ sourceEntryId: "result", originalParentId: "compact" }),
		});
		expect(replay.at(-1)).toMatchObject({
			content: [{ type: "text", text: "later response" }],
		});
		expect(entries.map((item) => item.id)).toEqual(expect.arrayContaining(input.map((item) => item.id)));
		expect(
			entries.reduce(
				(sum, item) =>
					sum +
					(item.type === "message" && item.message.role === "assistant" ? item.message.usage.totalTokens : 0),
				0,
			),
		).toBe(14);
		expect(readFileSync(source, "utf8")).toBe(bytes);
	});

	it("converts windows on both branches without reviving old conversation and retains handoff and prompt", () => {
		const input = settled();
		for (const branch of ["a", "b"]) {
			input.push(
				entry(branch, "final", {
					type: "context_window",
					handoff: `continue ${branch}`,
					tokensBefore: null,
					systemMessage: {
						role: "system",
						content: `prompt ${branch}`,
						timestamp: 2,
						replace: true,
						nativeHead: true,
					},
				}),
			);
			input.push(
				entry(`${branch}-user`, branch, {
					type: "message",
					message: { role: "user", content: `new ${branch}`, timestamp: 3 },
				}),
			);
		}
		const { source, output } = fixture(input);
		convertSessionFile(source, output);
		const entries = convertedEntries(output);
		for (const branch of ["a", "b"]) {
			const context = buildSessionContext(entries, `${branch}-user`);
			expect(context.messages.map((message) => message.role)).toEqual(["system", "compactionSummary", "user"]);
			expect(context.messages[0]).toMatchObject({ content: `prompt ${branch}` });
			expect(context.messages[1]).toMatchObject({ summary: expect.stringContaining(`continue ${branch}`) });
			expect(JSON.stringify(context.messages)).not.toContain("completed response");
		}
	});

	it("accepts settled steering status transitions without delivering their input again", () => {
		const input = settled();
		const message = { role: "user", content: "already delivered", timestamp: 2 };
		input.push(
			entry("queued", "final", {
				type: "custom",
				customType: "response-steering",
				data: { steeringId: "steer", status: "accepted", message },
			}),
		);
		input.push(
			entry("applied", "queued", {
				type: "custom",
				customType: "response-steering",
				data: { steeringId: "steer", status: "applied", message },
			}),
		);
		input.push(entry("delivered", "applied", { type: "message", message }));
		const { source, output } = fixture(input);
		convertSessionFile(source, output);
		expect(buildSessionContext(convertedEntries(output)).messages.filter((item) => item.role === "user")).toEqual([
			message,
		]);
	});

	it("pairs concurrent receipts before intervening turns, then retains only the requested window receipt", () => {
		const secondCall = { ...call, id: "second-call" };
		const input = settled();
		(input[1].message as Entry).content = [call, secondCall];
		(input[3].message as Entry).content = [call, secondCall, { type: "text", text: "final first response" }];
		input.splice(
			3,
			0,
			entry("second-result", "result", {
				type: "message",
				message: { ...(input[2].message as Entry), toolCallId: "second-call", details: { preserved: true }, usage },
			}),
			entry("second-snapshot", "second-result", {
				type: "message",
				checkpoint: true,
				concurrentToolResultIds: ["result", "second-result"],
				message: assistant([{ type: "text", text: "second response" }], {
					responseId: "second-response",
					stopReason: "pending",
				}),
			}),
			entry("second-final", "second-snapshot", {
				type: "message",
				concurrentToolResultIds: [],
				message: assistant([{ type: "text", text: "second response" }], {
					responseId: "second-response",
					stopReason: "stop",
				}),
			}),
			entry("third", "second-final", {
				type: "message",
				concurrentToolResultIds: ["result"],
				message: assistant([{ type: "text", text: "third response" }], {
					responseId: "third-response",
					stopReason: "stop",
				}),
			}),
		);
		input[7].parentId = "third";
		input.splice(
			4,
			0,
			entry("interruption", "second-result", {
				type: "message",
				message: { role: "user", content: "intervening input", timestamp: 2 },
			}),
		);
		input[5].parentId = "interruption";
		input.push(entry("before-window", "final", { type: "session_info", name: "preserved name" }));
		input.push(
			entry("window", "before-window", {
				type: "context_window",
				tokensBefore: 20,
				handoff: "use only the second receipt",
				retainedToolResultIds: ["second-result"],
			}),
		);
		const { source, output, bytes } = fixture(input);
		convertSessionFile(source, output);
		const entries = convertedEntries(output);
		providerReplay(entries, ["call", "second-call"], "before-window");
		const before = buildSessionContext(entries, "before-window");
		expect(before.messages.map((message) => message.role)).toEqual([
			"system",
			"assistant",
			"toolResult",
			"toolResult",
			"user",
			"assistant",
			"assistant",
		]);
		expect(before.messages[1]).toMatchObject({
			content: [
				{ type: "toolCall", id: "call", name: "lookup", arguments: { query: "example" } },
				{ type: "toolCall", id: "second-call", name: "lookup", arguments: { query: "example" } },
				{ type: "text", text: "final first response" },
			],
		});
		expect(before.messages[2]).toMatchObject({
			toolCallId: "call",
			content: [{ type: "text", text: "final result" }],
		});
		expect(before.messages[3]).toMatchObject({ toolCallId: "second-call", details: { preserved: true }, usage });
		expect(before.messages[4]).toMatchObject({ role: "user", content: "intervening input" });
		expect(before.messages[5]).toMatchObject({ content: [{ type: "text", text: "second response" }] });
		expect(before.messages[6]).toMatchObject({ content: [{ type: "text", text: "third response" }] });
		const after = buildSessionContext(entries);
		expect(after.messages.map((message) => message.role)).toEqual(["compactionSummary", "assistant", "toolResult"]);
		expect(after.messages[1]).toMatchObject({
			content: [{ type: "toolCall", id: "second-call", name: "lookup", arguments: { query: "example" } }],
		});
		expect(after.messages[2]).toMatchObject({ toolCallId: "second-call", details: { preserved: true } });
		expect(after.messages[2]).not.toHaveProperty("usage");
		providerReplay(entries, ["second-call"]);
		expect(
			entries.reduce(
				(sum, item) =>
					sum +
					(item.type === "message" && item.message.role === "assistant" ? item.message.usage.totalTokens : 0),
				0,
			),
		).toBe(21);
		expect(entries.map((item) => item.id)).toEqual(expect.arrayContaining(input.map((item) => item.id)));
		expect(entries).toContainEqual(
			expect.objectContaining({ customType: "legacy-conversion-snapshot", data: { original: input[6] } }),
		);
		expect(readFileSync(source, "utf8")).toBe(bytes);
	});

	it.each(["failed", "unknown"])(
		"archives %s steering, including queued records without IDs, only after durable delivery",
		(status) => {
			const input = settled();
			const message = { role: "user", content: "durable steering", timestamp: 2 };
			for (const [index, state] of ["queued", "accepted", status].entries()) {
				input.push(
					entry(`steer-${index}`, index === 0 ? "final" : `steer-${index - 1}`, {
						type: "custom",
						customType: "response-steering",
						data: {
							status: state,
							responseId: "response",
							message,
							...(index === 0 ? {} : { steeringId: "steer" }),
						},
					}),
				);
			}
			input.push(entry("delivered", "steer-2", { type: "message", message }));
			input.push(
				entry("completed", "delivered", {
					type: "message",
					message: assistant([{ type: "text", text: "continued" }], {
						responseId: "continued",
						stopReason: "stop",
					}),
				}),
			);
			const { source, output } = fixture(input);
			convertSessionFile(source, output);
			const entries = convertedEntries(output);
			expect(buildSessionContext(entries).messages.filter((item) => item.role === "user")).toEqual([message]);
			expect(
				entries
					.filter((item) => item.type === "custom" && item.customType === "legacy-conversion-steering")
					.map((item) => item.type === "custom" && item.data),
			).toEqual(input.slice(4, 7).map((item) => item.data));
		},
	);

	it("promotes result declarations at the receipt position and keeps every child branch behind them", () => {
		const input = settled();
		const declaration = {
			name: "found",
			namespace: "docs",
			description: "Discovered",
			parameters: { type: "object" },
		};
		(input[2].message as Entry).toolsAdded = [declaration];
		(input[2].message as Entry).details = { evidence: "receipt details" };
		input.push(entry("other", "result", { type: "message", message: input[3].message }));
		const { source, output } = fixture(input);
		convertSessionFile(source, output);
		const entries = convertedEntries(output);
		for (const leaf of ["final", "other"]) {
			const context = buildSessionContext(entries, leaf);
			expect(context.messages.map((message) => message.role)).toEqual([
				"system",
				"assistant",
				"toolResult",
				"system",
			]);
			expect(context.messages[2]).toMatchObject({ details: { evidence: "receipt details" } });
			expect(context.messages[2]).not.toHaveProperty("toolsAdded");
			expect(context.messages[3]).toEqual({
				role: "system",
				content: "",
				timestamp: 1,
				toolsAdded: [{ name: "found", description: "Discovered", parameters: { type: "object" } }],
			});
			expect(getCurrentTools(context.messages).map((tool) => tool.name)).toEqual(["lookup", "found"]);
		}
		expect(entries).toContainEqual(
			expect.objectContaining({
				customType: "legacy-conversion-metadata",
				data: expect.objectContaining({ sourceEntryId: "result", toolsAdded: [declaration] }),
			}),
		);
	});

	it("keeps declaration removal and addition stationary when relocating receipts before ordinary branches", () => {
		const declaration = {
			name: "found",
			namespace: "docs",
			description: "Discovered",
			parameters: { type: "object" },
		};
		const input = [
			settled()[0],
			entry("calling", "system", { type: "message", message: assistant([call]) }),
			entry("remove", "calling", {
				type: "message",
				message: {
					role: "system",
					content: "",
					timestamp: 1,
					toolsRemoved: [{ name: "found", namespace: "docs" }],
				},
			}),
			entry("user", "remove", {
				type: "message",
				message: { role: "user", content: "keep this input", timestamp: 2 },
			}),
			entry("later", "user", {
				type: "message",
				message: assistant([{ type: "text", text: "later response" }], { responseId: "later", stopReason: "stop" }),
			}),
			entry("result", "later", {
				type: "message",
				message: {
					...(settled()[2].message as Entry),
					toolsAdded: [declaration],
					details: { preserved: true },
					usage,
				},
			}),
			entry("label", "result", { type: "label", targetId: "result", label: "receipt" }),
			entry("summary", "result", { type: "branch_summary", fromId: "result", summary: "left branch context" }),
		];
		const { source, output, bytes } = fixture(input);
		convertSessionFile(source, output);
		const entries = convertedEntries(output);
		for (const leaf of ["label", "summary"]) {
			const messages = providerReplay(entries, ["call"], leaf);
			expect(messages[2]).toMatchObject({ toolCallId: "call", details: { preserved: true }, usage });
			const context = buildSessionContext(entries, leaf);
			expect(getCurrentTools(context.messages).map((tool) => tool.name)).toEqual(["lookup", "found"]);
			expect(context.messages.filter((message) => message.role === "user")).toEqual([
				{ role: "user", content: "keep this input", timestamp: 2 },
			]);
			expect(context.messages.filter((message) => message.role === "assistant").at(-1)).toMatchObject({
				content: [{ type: "text", text: "later response" }],
			});
		}
		const summary = entries.find((item) => item.id === "summary");
		expect(summary).toMatchObject({
			fromId: entries.find(
				(item) =>
					item.type === "message" &&
					item.message.role === "system" &&
					item.message.toolsAdded?.[0]?.name === "found",
			)?.id,
		});
		expect(entries.find((item) => item.id === "label")).toMatchObject({ targetId: "result" });
		expect(entries).toContainEqual(
			expect.objectContaining({
				customType: "legacy-conversion-metadata",
				data: expect.objectContaining({ sourceEntryId: "summary", originalFromId: "result" }),
			}),
		);
		expect(readFileSync(source, "utf8")).toBe(bytes);
	});

	it("reversibly aliases colliding identities in declarations, calls, results and removals without renaming other tools", () => {
		const input = settled();
		const definitions = (input[0].message as Entry).toolsAdded as Entry[];
		definitions.push({ ...definitions[0], namespace: "other", description: "Other lookup" });
		definitions.push({ name: "lookup", description: "Plain lookup", parameters: {} });
		definitions.push({ name: "unchanged", description: "Unique tool", parameters: {} });
		(input[2].message as Entry).toolsAdded = [
			{ ...definitions[0], namespace: "other", description: "Updated other" },
		];
		input.push(
			entry("other-call", "final", {
				type: "message",
				message: assistant([{ ...call, id: "other-call", namespace: "other" }], { responseId: "other-response" }),
			}),
		);
		input.push(
			entry("other-result", "other-call", {
				type: "message",
				message: { ...(input[2].message as Entry), toolCallId: "other-call", namespace: "other", toolsAdded: [] },
			}),
		);
		input.push(
			entry("remove", "other-result", {
				type: "message",
				message: {
					role: "system",
					content: "",
					timestamp: 4,
					toolsRemoved: [{ name: "lookup", namespace: "docs" }, "lookup"],
				},
			}),
		);
		const { source, output } = fixture(input);
		convertSessionFile(source, output);
		const entries = convertedEntries(output);
		const context = buildSessionContext(entries);
		const tools = getCurrentTools(context.messages);
		expect(tools).toHaveLength(2);
		expect(tools[0].description).toBe("Updated other");
		expect(tools[1]).toEqual({ name: "unchanged", description: "Unique tool", parameters: {} });
		const calls = context.messages.flatMap((message) =>
			message.role === "assistant" ? message.content.filter((block) => block.type === "toolCall") : [],
		);
		expect(new Set(calls.map((item) => item.name)).size).toBe(2);
		const receipts = context.messages.filter((message) => message.role === "toolResult");
		expect(receipts.map((item) => item.toolName)).toEqual(calls.map((item) => item.name));
		expect(tools[0].name).toBe(calls[1].name);
		const system = context.messages[0];
		if (system.role !== "system") throw new Error("Expected declarations");
		const plainName = system.toolsAdded!.find((tool) => tool.description === "Plain lookup")!.name;
		expect(new Set(system.toolsAdded!.map((tool) => tool.name)).size).toBe(4);
		expect(context.messages.at(-1)).toMatchObject({ toolsRemoved: [{ name: calls[0].name }, { name: plainName }] });
		const aliases = entries.find(
			(item) => item.type === "custom" && item.customType === "legacy-conversion-tool-aliases",
		);
		expect(aliases).toMatchObject({
			data: [
				{ namespace: "docs", name: "lookup", convertedName: calls[0].name },
				{ namespace: "other", name: "lookup", convertedName: calls[1].name },
				{ namespace: null, name: "lookup", convertedName: plainName },
			],
		});
		const secondOutput = join(directories.at(-1)!, "second.jsonl");
		convertSessionFile(source, secondOutput);
		expect(buildSessionContext(convertedEntries(secondOutput)).messages).toEqual(context.messages);

		// A pre-existing public name must never collide with a generated historical alias.
		definitions.push({ name: calls[0].name, description: "Reserved public name", parameters: {} });
		const reserved = fixture(input);
		convertSessionFile(reserved.source, reserved.output);
		const reservedTools = getCurrentTools(buildSessionContext(convertedEntries(reserved.output)).messages);
		expect(reservedTools.map((tool) => tool.name)).toEqual([calls[1].name, "unchanged", calls[0].name]);
		expect(reservedTools.at(-1)?.description).toBe("Reserved public name");
	});

	it.each(["no delivery", "duplicate delivery", "other branch", "no completed response", "conflicting identity"])(
		"refuses historically unknown steering with %s",
		(kind) => {
			const input = settled();
			const message = { role: "user", content: "uncertain", timestamp: 2 };
			input.push(
				entry("queued", "final", {
					type: "custom",
					customType: "response-steering",
					data: { status: "queued", responseId: "response", message },
				}),
			);
			if (kind === "conflicting identity")
				input.push(
					entry("accepted", "queued", {
						type: "custom",
						customType: "response-steering",
						data: {
							steeringId: "steer",
							status: "accepted",
							responseId: "response",
							message: { ...message, content: "other input" },
						},
					}),
				);
			input.push(
				entry("unknown", kind === "conflicting identity" ? "accepted" : "queued", {
					type: "custom",
					customType: "response-steering",
					data: { steeringId: "steer", status: "unknown", responseId: "response", message },
				}),
			);
			if (kind !== "no delivery")
				input.push(entry("delivered", kind === "other branch" ? "final" : "unknown", { type: "message", message }));
			if (kind === "duplicate delivery") input.push(entry("duplicate", "delivered", { type: "message", message }));
			if (kind !== "no completed response")
				input.push(
					entry("continued", input.at(-1)!.id as string, {
						type: "message",
						message: assistant([], { responseId: "continued", stopReason: "stop" }),
					}),
				);
			const { source, output, bytes } = fixture(input);
			expect(() => convertSessionFile(source, output)).toThrow(/steering/);
			expect(existsSync(output)).toBe(false);
			expect(readFileSync(source, "utf8")).toBe(bytes);
		},
	);

	it.each([
		"causal branch",
		"causal cut",
		"causal compaction carry",
		"mismatched receipt",
		"nonunique final",
		"malformed declaration",
	])("refuses unsupported or unsafe reconstruction: %s", (kind) => {
		const input = settled();
		if (kind.startsWith("causal")) {
			input.push(
				entry("later", "final", {
					type: "message",
					concurrentToolResultIds: ["result"],
					message: assistant([], { responseId: "later", stopReason: "stop" }),
				}),
			);
			if (kind === "causal branch") input.push(entry("other", "final", { type: "session_info", name: "other" }));
			else if (kind === "causal compaction carry")
				input.push(
					entry("compact", "later", {
						type: "compaction",
						summary: "cut",
						firstKeptEntryId: "later",
						tokensBefore: 1,
					}),
				);
			else {
				input.splice(
					4,
					0,
					entry("cut", "final", { type: "context_window", tokensBefore: 1, retainedToolResultIds: ["result"] }),
				);
				input[5].parentId = "cut";
			}
		} else if (kind === "mismatched receipt") (input[2].message as Entry).namespace = "wrong";
		else if (kind === "nonunique final")
			input.push(entry("duplicate-final", "final", { type: "message", message: input[3].message }));
		else (input[2].message as Entry).toolsAdded = [{ name: "bad", description: 1, parameters: {} }];
		const { source, output, bytes } = fixture(input);
		const reason =
			kind === "causal branch"
				? /causal.*branch/
				: kind === "causal cut"
					? /causal.*boundary/
					: kind === "causal compaction carry"
						? /boundary compact carries result call without its original call/
						: kind === "mismatched receipt"
							? /mismatched result/
							: kind === "nonunique final"
								? /unique final/
								: /tool description/;
		expect(() => convertSessionFile(source, output)).toThrow(reason);
		expect(existsSync(output)).toBe(false);
		expect(readFileSync(source, "utf8")).toBe(bytes);
	});

	it.each([
		"same path",
		"existing file",
		"symlink",
		"dangling symlink",
		"directory",
		...(process.platform === "android" ? [] : ["hard link"]),
	])("never overwrites %s", (collision) => {
		const { source, output, bytes } = fixture(settled());
		if (collision === "existing file") writeFileSync(output, "keep me");
		if (collision === "symlink") symlinkSync(source, output);
		if (collision === "dangling symlink") symlinkSync("missing", output);
		if (collision === "directory") mkdirSync(output);
		if (collision === "hard link") linkSync(source, output);
		const before = lstatSync(collision === "same path" ? source : output);
		expect(() => convertSessionFile(source, collision === "same path" ? source : output)).toThrow();
		const after = lstatSync(collision === "same path" ? source : output);
		expect([after.dev, after.ino, after.mode]).toEqual([before.dev, before.ino, before.mode]);
		expect(readFileSync(source, "utf8")).toBe(bytes);
		if (collision === "existing file") expect(readFileSync(output, "utf8")).toBe("keep me");
	});

	it("publishes exactly one complete journal when conversions race for the same output", async () => {
		const { directory, source, output, bytes } = fixture(settled());
		const script = join(directory, "race.mjs");
		writeFileSync(
			script,
			`import { convertSessionFile } from ${JSON.stringify(new URL("../src/core/session-conversion.ts", import.meta.url).href)};\nconvertSessionFile(process.argv[2], process.argv[3]);\n`,
		);
		const run = promisify(execFile);
		const results = await Promise.allSettled(
			[0, 1].map(() => run(process.execPath, [script, source, output], { timeout: 30_000 })),
		);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(buildSessionContext(convertedEntries(output)).messages.map((message) => message.role)).toEqual([
			"system",
			"assistant",
			"toolResult",
		]);
		expect(readFileSync(source, "utf8")).toBe(bytes);
		expect(readdirSync(directory).sort()).toEqual(["converted.jsonl", "original.jsonl", "race.mjs"]);
	});

	it.each([
		[
			"unfinished side branch",
			(input: Entry[]) => input.push(entry("unsafe", "snapshot", { type: "session_info", name: "unfinished" })),
		],
		[
			"missing receipt",
			(input: Entry[]) => {
				input[2] = entry("result", "snapshot", { type: "session_info" });
			},
		],
		[
			"dangling reference",
			(input: Entry[]) => input.push(entry("label", "final", { type: "label", targetId: "missing", label: "bad" })),
		],
		["duplicate entry", (input: Entry[]) => input.push(input[0])],
		[
			"malformed system checkpoint",
			(input: Entry[]) =>
				input.push(
					entry("window", "final", {
						type: "context_window",
						tokensBefore: 20,
						systemMessage: { role: "system", timestamp: 1 },
					}),
				),
		],
		[
			"applied steering missing its durable input",
			(input: Entry[]) =>
				input.push(
					entry("steer", "final", {
						type: "custom",
						customType: "response-steering",
						data: {
							steeringId: "s",
							status: "applied",
							message: { role: "user", content: "lost", timestamp: 2 },
						},
					}),
				),
		],
		[
			"call straddling an unsupported compaction cut",
			(input: Entry[]) => {
				input.splice(
					2,
					0,
					entry("window", "snapshot", {
						type: "compaction",
						summary: "cut",
						firstKeptEntryId: "window",
						tokensBefore: 1,
					}),
				);
				input[3].parentId = "window";
			},
		],
		[
			"edit of a coalesced snapshot",
			(input: Entry[]) =>
				input.push(entry("edit", "final", { type: "context_edit", targetId: "final", replacement: null })),
		],
		[
			"malformed message",
			(input: Entry[]) => {
				input[2].message = null;
			},
		],
		[
			"cycle",
			(input: Entry[]) => {
				input[0].parentId = "final";
			},
		],
		[
			"unsettled steering",
			(input: Entry[]) =>
				input.push(
					entry("steering", "final", {
						type: "custom",
						customType: "response-steering",
						data: { steeringId: "steer", status: "unknown" },
					}),
				),
		],
		[
			"invalid retained receipt",
			(input: Entry[]) =>
				input.push(
					entry("window", "final", { type: "context_window", tokensBefore: 1, retainedToolResultIds: ["final"] }),
				),
		],
	] as const)("refuses %s before publication, including inactive branches", (_name, change) => {
		const input = settled();
		change(input);
		const { source, output, bytes, directory } = fixture(input);
		expect(() => convertSessionFile(source, output)).toThrow(/conversion refused/);
		expect(readFileSync(source, "utf8")).toBe(bytes);
		expect(existsSync(output)).toBe(false);
		expect(readdirSync(directory)).toEqual(["original.jsonl"]);
	});

	it("refuses truncated JSON without creating an output", () => {
		const { source, output } = fixture(settled());
		writeFileSync(source, `${readFileSync(source, "utf8")}{"type":`);
		expect(() => convertSessionFile(source, output)).toThrow(/invalid JSONL/);
		expect(existsSync(output)).toBe(false);
	});

	it.each([null, { content: [{ type: "text", text: "redacted" }] }, { content: [] }])(
		"refuses edits that could restore an omitted async receipt after compaction: %j",
		(replacement) => {
			const input = [
				entry("call", null, { type: "message", message: assistant([call]) }),
				entry("result", "call", { type: "message", message: settled()[2].message }),
				entry("edit", "result", { type: "context_edit", targetId: "call", replacement }),
				entry("compact", "edit", {
					type: "compaction",
					firstKeptEntryId: "call",
					summary: "summary",
					tokensBefore: 1,
				}),
			];
			const { source, output, bytes } = fixture(input);
			expect(() => convertSessionFile(source, output)).toThrow("changes legacy execution history");
			expect(readFileSync(source, "utf8")).toBe(bytes);
			expect(existsSync(output)).toBe(false);
		},
	);

	it.each(["error", "aborted"])(
		"refuses edits of interrupted %s execution history before publication",
		(stopReason) => {
			for (const replacement of [null, { content: [{ type: "text", text: "redacted" }] }]) {
				const input = [
					entry("failed", null, {
						type: "message",
						message: assistant(
							[
								{ type: "text", text: "signed content removed by edit", textSignature: "msg_done" },
								{ ...call, async: false },
							],
							{ stopReason },
						),
					}),
					entry("result", "failed", { type: "message", message: settled()[2].message }),
					entry("edit", "result", { type: "context_edit", targetId: "failed", replacement }),
				];
				const { source, output, bytes, directory } = fixture(input);
				expect(() => convertSessionFile(source, output)).toThrow("changes legacy execution history");
				expect(readFileSync(source, "utf8")).toBe(bytes);
				expect(existsSync(output)).toBe(false);
				expect(readdirSync(directory)).toEqual(["original.jsonl"]);
			}
		},
	);

	it("converts a long linear journal within a bounded process heap", () => {
		const input = Array.from({ length: 10_000 }, (_, index) =>
			entry(String(index), index === 0 ? null : String(index - 1), { type: "session_info", name: `entry ${index}` }),
		);
		const { directory, source, output, bytes } = fixture(input);
		const script = join(directory, "convert.mjs");
		writeFileSync(
			script,
			`import { convertSessionFile } from ${JSON.stringify(new URL("../src/core/session-conversion.ts", import.meta.url).href)};\nconvertSessionFile(process.argv[2], process.argv[3]);\n`,
		);
		execFileSync(process.execPath, ["--max-old-space-size=128", script, source, output], { timeout: 30_000 });
		expect(readFileSync(source, "utf8")).toBe(bytes);
		expect(convertedEntries(output)).toEqual(input);
	});

	it("startup distinguishes retired mechanisms from ordinary upstream and unrelated extension data", () => {
		expect(() =>
			assertSessionConversionNotRequired([
				header,
				entry("system", null, {
					type: "message",
					message: { role: "system", content: "", timestamp: 0, toolsRemoved: ["old", { name: "other" }] },
				}),
				entry("user", null, { type: "message", message: { role: "user", content: "hello", timestamp: 0 } }),
				entry("data", "user", {
					type: "custom",
					customType: "extension",
					data: { async: true, context_window: "not runtime" },
				}),
				entry("assistant", "data", {
					type: "message",
					message: assistant([
						{ type: "toolCall", id: "call", name: "lookup", namespace: "provider-native", arguments: {} },
					]),
				}),
				entry("edit", "assistant", {
					type: "context_edit",
					targetId: "assistant",
					replacement: { arbitrary: true },
				}),
				entry("other-edit", "edit", { type: "context_edit", targetId: "assistant", replacement: [] }),
			]),
		).not.toThrow();
		expect(() => assertSessionConversionNotRequired(settled())).toThrow(/one-time conversion/);
		expect(() => assertSessionConversionNotRequired(settled())).toThrow(/pi convert-session SOURCE NEW_PATH/);
		expect(() =>
			assertSessionConversionNotRequired([
				entry("edit", null, {
					type: "context_edit",
					targetId: "call",
					replacement: { content: [{ type: "toolCall", async: true }] },
				}),
			]),
		).toThrow(/one-time conversion/);
		expect(() => assertSessionConversionNotRequired([null])).toThrow();
	});
});
