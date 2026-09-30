import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { convertSessionFile } from "../../src/core/session-conversion.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

const directory = process.argv[2]!;
const source = join(directory, "source.jsonl");
const timestamp = "2026-09-01T00:00:00.000Z";
const header = { type: "session", version: 3, id: "source-owner", cwd: directory, timestamp };
const expected = new Map<string, string>();
const usage = {
	input: 5,
	output: 2,
	cacheRead: 3,
	cacheWrite: 1,
	totalTokens: 11,
	cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
};
const fd = openSync(source, "wx", 0o600);
let parentId: string | null = null;
function record(id: string, fields: Record<string, unknown>): void {
	const value = { type: "custom", id, parentId, timestamp, ...fields };
	const json = JSON.stringify(value);
	writeFileSync(fd, `${json}\n`);
	expected.set(id, createHash("sha256").update(json).digest("hex"));
	parentId = id;
}
try {
	writeFileSync(fd, `${JSON.stringify(header)}\n`);
	record("model", { type: "model_change", provider: "test", modelId: "selected" });
	record("thinking", { type: "thinking_level_change", thinkingLevel: "high" });
	const chunk = Buffer.alloc(1024 * 1024, "x");
	for (let index = 0; index < 129; index++) {
		const id = `body-${index}`;
		const prefix = `${JSON.stringify({ type: "custom", id, parentId, timestamp, customType: "browser" }).slice(0, -1)},"data":{"ignored":"`;
		const hash = createHash("sha256").update(prefix);
		writeFileSync(fd, prefix);
		// Both cumulative history and one giant individual value exceed normal heap capacity.
		const count = index === 0 ? 264 : 2;
		for (let part = 0; part < count; part++) {
			writeFileSync(fd, chunk);
			hash.update(chunk);
		}
		writeFileSync(fd, '"}}\n');
		hash.update('"}}');
		expected.set(id, hash.digest("hex"));
		parentId = id;
	}
	record("usage", {
		type: "usage",
		kind: "child_work",
		provider: "test",
		model: "selected",
		contributionId: "receipt",
		usage,
	});
	record("user", { type: "message", message: { role: "user", content: "Unicode 雪 🦄", timestamp: 1 } });
	record("label", { type: "label", targetId: "user", label: "selected path" });
	record("compact", { type: "compaction", summary: "summary", firstKeptEntryId: "user", tokensBefore: 10 });
	record("latest", { type: "custom", customType: "small", data: { exact: [false, null, 0] } });
} finally {
	closeSync(fd);
}

// Independent byte framing verifies that copied ignored bodies were neither omitted nor truncated.
function digests(path: string): string[] {
	const handle = openSync(path, "r");
	const buffer = Buffer.allocUnsafe(64 * 1024);
	const values: string[] = [];
	let hash = createHash("sha256");
	try {
		for (;;) {
			const count = readSync(handle, buffer, 0, buffer.length, null);
			if (!count) break;
			let start = 0;
			for (let index = 0; index < count; index++)
				if (buffer[index] === 10) {
					hash.update(buffer.subarray(start, index));
					values.push(hash.digest("hex"));
					hash = createHash("sha256");
					start = index + 1;
				}
			hash.update(buffer.subarray(start, count));
		}
	} finally {
		closeSync(handle);
	}
	return values;
}
const original = digests(source);
assert(statSync(source).size > 512 * 1024 * 1024);
const manager = SessionManager.open(source);
assert.equal(manager.getSessionId(), "source-owner");
assert.equal([...manager.iterateEntryMetadata()].length, expected.size);
assert.deepEqual([...manager.iterateEntryMetadata({ branchFrom: null })], []);
assert.deepEqual(manager.getEntryMetadata("usage"), {
	type: "usage",
	id: "usage",
	parentId: "body-128",
	timestamp,
	kind: "child_work",
	provider: "test",
	model: "selected",
	contributionId: "receipt",
	usage,
	sequence: 131,
});
assert.deepEqual(manager.buildSessionContext(), {
	messages: [
		{ role: "compactionSummary", summary: "summary", tokensBefore: 10, timestamp: Date.parse(timestamp) },
		{ role: "user", content: "Unicode 雪 🦄", timestamp: 1 },
	],
	thinkingLevel: "high",
	model: { provider: "test", modelId: "selected" },
});
assert.deepEqual(JSON.parse(JSON.stringify(manager.getEntry("latest"))), {
	type: "custom",
	id: "latest",
	parentId: "compact",
	timestamp,
	customType: "small",
	data: { exact: [false, null, 0] },
});
assert.equal(manager.getTree().length, 1);
const fork = SessionManager.forkFrom(source, directory, directory);
assert.notEqual(fork.getSessionId(), "source-owner");
assert.deepEqual(digests(fork.getSessionFile()!).slice(1), original.slice(1));
const branch = manager.createBranchedSession("latest")!;
assert.notEqual(manager.getSessionId(), "source-owner");
assert.equal(manager.getEntryMetadata("compact")!.parentId, "user");
assert.equal(manager.getLabel("user"), "selected path");
const branchDigests = digests(branch);
for (let index = 0; index < 129; index++) assert.equal(branchDigests[index + 3], expected.get(`body-${index}`));
const converted = join(directory, "converted.jsonl");
convertSessionFile(source, converted);
assert.deepEqual(digests(converted), original);
assert.deepEqual(digests(source), original);
assert(global.gc, "Run this fixture with --expose-gc to measure retained history");
global.gc();
process.stdout.write(
	`${JSON.stringify({ bytes: statSync(source).size, entries: expected.size, retainedHeap: process.memoryUsage().heapUsed, copiesVerified: true })}\n`,
);
