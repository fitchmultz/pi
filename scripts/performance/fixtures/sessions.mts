import assert from "node:assert/strict";
import { closeSync, mkdtempSync, openSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fauxAssistantMessage } from "/pi-performance-source/packages/ai/src/providers/faux.ts";
import { createAssistantMessageEventStream } from "/pi-performance-source/packages/ai/src/utils/event-stream.ts";
import { prepareBranchEntries } from "/pi-performance-source/packages/coding-agent/src/core/compaction/branch-summarization.ts";
import {
	compact,
	prepareCompaction,
} from "/pi-performance-source/packages/coding-agent/src/core/compaction/compaction.ts";
import {
	type FileEntry,
	type SessionEntry,
	SessionManager,
} from "/pi-performance-source/packages/coding-agent/src/core/session-manager.ts";
import {
	copyWorkingSession,
	copyWorkingSessionMemory,
} from "/pi-performance-source/packages/coding-agent/src/core/working-session.ts";
import { createHarness } from "/pi-performance-source/packages/coding-agent/test/suite/harness.ts";
import { witness } from "../proof.mjs";

const mode = process.argv[2] ?? "projection";
const smoke = process.argv.includes("--smoke");
const count = Number(process.env.SESSION_ENTRIES ?? (smoke ? 20 : 10_000));
const iterations = Number(process.env.SESSION_ITERATIONS ?? (smoke ? 1 : 25));
const payloadBytes = Number(process.env.SESSION_PAYLOAD_BYTES ?? 128);
const payload = "x".repeat(payloadBytes);
assert(Number.isSafeInteger(count) && count > 0);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const stamp = "2026-10-12T00:00:00.000Z";
let sink = 0;

function history(n: number, offBranch = false, named = false): FileEntry[] {
	const entries: FileEntry[] = [
		{ type: "session", version: 3, id: "performance-session", timestamp: stamp, cwd: "/tmp" },
	];
	let parentId: string | null = null;
	if (named) {
		entries.push({ type: "session_info", id: "name", parentId, timestamp: stamp, name: "old name" });
		parentId = "name";
	}
	for (let i = 0; i < n; i++) {
		const id = `old-${i}`;
		entries.push({ type: "custom", id, parentId, timestamp: stamp, customType: "archived", data: payload });
		parentId = id;
	}
	entries.push({
		type: "compaction",
		id: "compact",
		parentId: offBranch ? null : parentId,
		timestamp: stamp,
		summary: "handoff",
		firstKeptEntryId: "compact",
		tokensBefore: 100_000,
	});
	entries.push({
		type: "message",
		id: "user",
		parentId: "compact",
		timestamp: stamp,
		message: { role: "user", content: "active input", timestamp: 1 },
	});
	const response = fauxAssistantMessage("active answer");
	response.usage.input = 1000;
	response.usage.totalTokens = 1000;
	entries.push({ type: "message", id: "answer", parentId: "user", timestamp: stamp, message: response });
	return entries;
}

async function measure(name: string, operation: () => unknown | Promise<unknown>, runs = iterations): Promise<void> {
	for (let i = 0; i < (smoke ? 0 : Math.min(3, runs)); i++) await operation();
	globalThis.gc?.();
	const heapBefore = process.memoryUsage().heapUsed;
	const samples: number[] = [];
	let lastValue: unknown;
	for (let i = 0; i < runs; i++) {
		const start = performance.now();
		const value = await operation();
		samples.push(performance.now() - start);
		lastValue = value;
		if (typeof value === "number") sink += value;
	}
	const heapAfter = process.memoryUsage().heapUsed;
	samples.sort((a, b) => a - b);
	witness(name, { mode, count, payloadBytes, runs }, lastValue);
	console.log(
		JSON.stringify({
			mode,
			name,
			count,
			payloadBytes,
			runs,
			medianMs: samples[Math.floor(samples.length / 2)],
			p95Ms: samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)],
			heapDeltaBytes: heapAfter - heapBefore,
		}),
	);
}

// Normalize fixture clocks and identities; retain content, ordering and graph references.
function semantic(
	value: unknown,
	harness: Awaited<ReturnType<typeof createHarness>>,
	ids = new Map<string, string>(),
): unknown {
	const model = harness.getModel();
	const text = JSON.stringify(value, function (this: { api?: string; role?: string }, key, item: unknown) {
		if (key === "timestamp" || key === "createdAt" || key === "durationMs") return undefined;
		// Faux prompt-token estimates include generated paths; their raw usage is logged separately.
		if (
			key === "usage" &&
			this.role === "assistant" &&
			this.api === model.api &&
			item !== null &&
			typeof item === "object" &&
			"input" in item &&
			"totalTokens" in item
		) {
			const { input: _input, totalTokens: _totalTokens, ...usage } = item;
			return usage;
		}
		if (typeof item !== "string") return item;
		if (ids.has(item)) return ids.get(item);
		if (item === model.api) return "<faux-api>";
		if (item === model.provider) return "<faux-provider>";
		return item;
	});
	if (text === undefined) return undefined;
	return JSON.parse(
		text
			.replaceAll(harness.tempDir, "<fixture>")
			.replaceAll(process.env.PI_CODING_AGENT_DIR ?? "<unset-agent>", "<agent>")
			.replaceAll(process.env.HOME ?? "<unset-home>", "<home>")
			.replaceAll(process.env.PI_PERF_REPO ?? "<unset-repo>", "<repo>"),
	);
}

function writeJournal(path: string, entries: FileEntry[]): void {
	const fd = openSync(path, "wx", 0o600);
	try {
		let chunk = "";
		for (const entry of entries) {
			chunk += `${JSON.stringify(entry)}\n`;
			if (chunk.length >= 64 * 1024) {
				writeFileSync(fd, chunk);
				chunk = "";
			}
		}
		if (chunk) writeFileSync(fd, chunk);
	} finally {
		closeSync(fd);
	}
}

if (mode === "projection") {
	for (const offBranch of [false, true]) {
		const manager = SessionManager.inMemory("/tmp", undefined, history(count, offBranch));
		assert.equal(manager.buildSessionProjection().messages.length, 3);
		await measure(
			offBranch ? "short-active-path-many-offbranch" : "compacted-linear-ancestry",
			() => manager.buildSessionProjection().messages.length,
		);
		await measure(
			offBranch ? "context-entries-offbranch" : "context-entries-linear",
			() => manager.buildContextEntries().length,
		);
	}
} else if (mode === "name") {
	for (const named of [false, true]) {
		const manager = SessionManager.inMemory("/tmp", undefined, history(count, false, named));
		assert.equal(manager.getSessionName(), named ? "old name" : undefined);
		await measure(named ? "name-near-start" : "unnamed", () => {
			for (let frame = 0; frame < 100; frame++) sink += manager.getSessionName()?.length ?? 0;
			return 100;
		});
	}
} else if (mode === "branch") {
	const entries: SessionEntry[] = Array.from({ length: count }, (_, i) => ({
		type: "message",
		id: `msg-${i}`,
		parentId: i ? `msg-${i - 1}` : null,
		timestamp: stamp,
		message: { role: "user", content: `entry ${i}`, timestamp: i },
	}));
	const prepared = prepareBranchEntries(entries, 0);
	assert.equal(prepared.messages.length, count);
	assert.equal(prepared.messages[0].role, "user");
	assert.equal("content" in prepared.messages[0] && prepared.messages[0].content, "entry 0");
	assert.equal(
		"content" in prepared.messages[count - 1] && prepared.messages[count - 1].content,
		`entry ${count - 1}`,
	);
	await measure("branch-preparation-full-budget", () => prepareBranchEntries(entries, 0).messages.length);
	// The tiny smoke input needs a smaller retention budget to exercise compaction.
	const compactionSettings = { enabled: true, reserveTokens: 16384, keepRecentTokens: smoke ? 1 : 200 };
	await measure(
		"compaction-preparation",
		() => prepareCompaction(entries, compactionSettings)?.messagesToSummarize.length ?? 0,
	);
	const compaction = prepareCompaction(entries, compactionSettings);
	assert.ok(compaction);
	if (smoke) {
		assert.equal(compaction.firstKeptEntryId, `msg-${count - 1}`);
		assert.equal(compaction.messagesToSummarize.length, count - 1);
	}
	witness(
		"compaction-output",
		{ count, payloadBytes, iterations },
		{
			...compaction,
			fileOps: {
				read: [...compaction.fileOps.read],
				edited: [...compaction.fileOps.edited],
				written: [...compaction.fileOps.written],
			},
		},
	);
} else if (mode === "fork") {
	const directory = mkdtempSync(join(tmpdir(), "pi-fork-"));
	try {
		const source = join(directory, "source.jsonl");
		writeJournal(source, history(count));
		console.log(JSON.stringify({ sourceBytes: statSync(source).size }));
		await measure(
			"forkFrom-write-and-reload",
			() => {
				const fork = SessionManager.forkFrom(source, "/tmp", directory);
				assert.equal(fork.buildSessionContext().messages.length, 3);
				return fork.getEntryCount();
			},
			smoke ? 1 : Math.min(iterations, 5),
		);
	} finally {
		rmSync(directory, { recursive: true });
	}
} else if (mode === "list") {
	const directory = mkdtempSync(join(tmpdir(), "pi-list-"));
	const files = smoke ? 3 : Number(process.env.SESSION_FILES ?? 30);
	try {
		for (let i = 0; i < files; i++) {
			const entries = history(count);
			const header = entries[0];
			assert.equal(header.type, "session");
			if (header.type !== "session") throw new Error("header");
			header.id = `list-${i}`;
			header.cwd = i % 3 ? "/tmp/other-workspace" : "/tmp";
			writeJournal(join(directory, `session-${i}.jsonl`), entries);
		}
		await measure(
			"list-custom-flat-current-cwd",
			async () => {
				const sessions = await SessionManager.list("/tmp", directory);
				assert.equal(sessions.length, Math.ceil(files / 3));
				assert(sessions.every((s) => s.cwd === "/tmp" && s.allMessagesText.includes("active input")));
				return sessions.length;
			},
			smoke ? 1 : Math.min(iterations, 5),
		);
		await measure(
			"list-custom-flat-all",
			async () => (await SessionManager.listAll(directory)).length,
			smoke ? 1 : Math.min(iterations, 5),
		);
		// Activity-clock ordering remains the owner tests' contract.
		const listed = await SessionManager.listAll(directory);
		assert.equal(listed.length, files);
		assert.deepEqual(
			listed.map((session) => session.id).sort(),
			Array.from({ length: files }, (_, i) => `list-${i}`).sort(),
		);
		const normalized = listed
			.map(({ modified: _modified, ...session }) => session)
			.sort((a, b) => a.id.localeCompare(b.id));
		witness(
			"session-list-all",
			{ count, payloadBytes, files, runs: Math.min(iterations, 5) },
			JSON.parse(JSON.stringify(normalized).replaceAll(directory, "<fixture>")),
		);
	} finally {
		rmSync(directory, { recursive: true });
	}
} else if (mode === "boundary" || mode === "context" || mode === "working") {
	for (const hooks of mode === "boundary" ? [false, true] : [false]) {
		const manager = SessionManager.inMemory("/tmp", undefined, history(count));
		const harness = await createHarness({
			sessionManager: manager,
			settings: { compaction: { enabled: false } },
			extensionFactories: hooks
				? [
						(pi) => {
							pi.on("turn_end", () => {});
							pi.on("agent_before_settle", () => {});
						},
					]
				: undefined,
		});
		let projections = 0;
		const project = manager.buildSessionProjection.bind(manager);
		manager.buildSessionProjection = () => {
			projections++;
			return project();
		};
		try {
			if (mode === "boundary") {
				await measure(hooks ? "prompt-noop-boundary-hooks" : "prompt-no-boundary-hooks", async () => {
					harness.setResponses([fauxAssistantMessage("done")]);
					await harness.session.prompt("start");
					return harness.faux.state.callCount;
				});
				witness(
					"boundary-transcript",
					{ mode, hooks, count, payloadBytes, iterations },
					semantic(harness.session.messages, harness),
				);
				console.log(
					JSON.stringify({
						hooks,
						projectionCalls: projections,
						fauxUsage: harness.session.messages.flatMap((message) =>
							message.role === "assistant" && message.api === harness.getModel().api ? [message.usage] : [],
						),
					}),
				);
			} else if (mode === "context") {
				harness.session.getContextUsage();
				await measure("same-leaf-context-usage-100-reads", () => {
					for (let i = 0; i < 100; i++) sink += harness.session.getContextUsage()?.tokens ?? 0;
					return 100;
				});
				await measure("new-leaf-context-usage", () => {
					manager.appendCustomEntry("bookkeeping", 1);
					return harness.session.getContextUsage()?.tokens ?? 0;
				});
				witness(
					"new-leaf-context",
					{ count, payloadBytes, iterations },
					semantic(harness.session.getContextUsage(), harness),
				);
			} else {
				harness.session.setWorkingSessionReady(true);
				const hold = await harness.session.acquireWorkingSession();
				try {
					await measure("copy-complete-working-session", () => copyWorkingSession(hold.state).entries.length);
					await measure(
						"copy-working-session-memory",
						() => copyWorkingSessionMemory(hold.state).activeTools.length,
					);
					const ids = new Map(hold.state.entries.map((entry, index) => [entry.id, `entry-${index}`]));
					witness(
						"working-state",
						{ count, payloadBytes, iterations },
						semantic(copyWorkingSession(hold.state), harness, ids),
					);
				} finally {
					await hold.release();
				}
			}
		} finally {
			harness.cleanup();
		}
	}
} else if (mode === "split") {
	const harness = await createHarness();
	let calls = 0;
	const delayMs = smoke ? 1 : Number(process.env.SESSION_SUMMARY_DELAY_MS ?? 100);
	try {
		await measure(
			"split-history-and-prefix-summaries",
			async () => {
				const result = await compact(
					{
						firstKeptEntryId: "kept",
						messagesToSummarize: [{ role: "user", content: "earlier work", timestamp: 1 }],
						turnPrefixMessages: [{ role: "user", content: "large current span", timestamp: 2 }],
						isSplitTurn: true,
						tokensBefore: 1000,
						fileOps: { read: new Set(), edited: new Set(), written: new Set() },
						settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 200 },
					},
					harness.getModel(),
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					() => {
						const stream = createAssistantMessageEventStream();
						const response = fauxAssistantMessage(`summary ${++calls}`);
						setTimeout(() => stream.push({ type: "done", reason: "stop", message: response }), delayMs);
						return stream;
					},
				);
				assert(result.summary.includes("Turn Context (split turn)"));
				return result.summary.length;
			},
			smoke ? 1 : Math.min(iterations, 5),
		);
		console.log(JSON.stringify({ calls, delayMs, expectedRequestsPerCompaction: 2 }));
	} finally {
		harness.cleanup();
	}
} else {
	throw new Error(`Unknown mode: ${mode}`);
}
console.log(JSON.stringify({ sink }));
