import assert from "node:assert/strict";
import { appendFileSync, chmodSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { type SessionInfoEntry, SessionManager } from "../../src/core/session-manager.ts";

const [directory, scenario] = process.argv.slice(2);
assert(directory && scenario);
const source = join(directory, "source.jsonl");
const body = { text: `${"complete body ".repeat(200)}end`, exact: [false, null, 0] };
const header = { type: "session", version: 3, id: "source", cwd: directory, timestamp: new Date(0).toISOString() };
const entries = [
	header,
	{ type: "custom", id: "body", parentId: null, customType: "kept", timestamp: header.timestamp, data: body },
];
const original = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
writeFileSync(source, original);
const acceptsScans = ["refresh-yield", "flush-retry", "same-file-reload"].includes(scenario);
const manager = acceptsScans ? SessionManager.open(source, directory) : SessionManager.inMemory(directory);
if (!acceptsScans) manager.setSessionFile(source);
const view = manager.getEntry("body");
assert(view?.type === "custom");
const shallow = manager.getEntries();
const branch = manager.getBranch();
const tree = manager.getTree();
const foreign = SessionManager.inMemory(directory, undefined, [manager.getHeader()!, ...shallow]);
foreign.createBranchedSession("body");
const foreignView = foreign.getEntry("body");
assert(foreignView?.type === "custom");
assert.notEqual(foreignView, view);

const rejected = join(directory, "rejected.jsonl");
let rejectedBytes = "";
if (scenario.endsWith("invalid-header")) rejectedBytes = '{"type":"custom","id":"invalid","customType":"test"}\n';
else if (scenario.endsWith("malformed")) rejectedBytes = "not JSON\n";
else if (scenario.endsWith("conversion"))
	rejectedBytes = `${JSON.stringify(header)}\n${JSON.stringify({ type: "context_window", id: "legacy", parentId: null })}`;
writeFileSync(rejected, rejectedBytes);
const blocked = join(directory, "blocked");
writeFileSync(blocked, "unrelated target bytes\n");
if (scenario === "open-empty-readonly") chmodSync(rejected, 0o400);
const beforeFiles = readdirSync(directory).sort();
let completed = 0;
let expected = original;
try {
	for (; completed < 320; completed++) {
		if (scenario === "refresh-yield") {
			const revision = manager.getEntriesRevision();
			const added: SessionInfoEntry = {
				type: "session_info",
				id: `external-${completed}`,
				parentId: view.id,
				timestamp: header.timestamp,
				name: `external ${completed}`,
			};
			const bytes = `${JSON.stringify(added)}\n`;
			appendFileSync(source, bytes);
			expected += bytes;
			assert.equal(manager.getEntriesRevision(), revision + 1);
			assert.equal(manager.getEntryMetadata(added.id)?.type, "session_info");
			assert.equal(manager.getLeafId(), view.id);
		} else if (scenario === "flush-retry") {
			const parent = manager.getLeafId();
			chmodSync(source, 0o400);
			try {
				assert.throws(() => manager.appendCustomEntry("accepted", { operation: completed }), /EACCES/);
			} finally {
				chmodSync(source, 0o600);
			}
			const id = manager.getLeafId();
			const accepted = manager.getChildren(parent!).find((entry) => entry.id === id);
			assert(accepted?.type === "custom");
			assert.deepEqual(accepted.data, { operation: completed });
			const bytes = `\n${JSON.stringify(accepted)}\n`;
			manager.flush();
			assert.equal(manager.getLeafId(), id);
			expected += bytes;
		} else if (scenario === "same-file-reload") {
			manager.setSessionFile(source);
			assert.equal(manager.getSessionId(), header.id);
		} else if (scenario === "resume-empty") {
			manager.setSessionFile(rejected);
			assert.equal(manager.getHeader()?.type, "session");
		} else if (scenario === "open-empty-readonly") {
			assert.throws(() => SessionManager.open(rejected, directory), /EACCES/, `attempt ${completed}`);
		} else if (scenario.startsWith("resume-")) {
			assert.throws(
				() => manager.setSessionFile(rejected),
				scenario.endsWith("conversion") ? /one-time conversion/ : /not a valid pi session/,
				`attempt ${completed}`,
			);
			assert.equal(manager.getSessionFile(), source);
			assert.equal(manager.getSessionId(), header.id);
		} else {
			const input = ["fork-directory", "fork-options", "fork-stage"].includes(scenario) ? source : rejected;
			const target =
				scenario === "fork-directory" ? join(blocked, "nested") : scenario === "fork-stage" ? blocked : directory;
			assert.throws(
				() =>
					SessionManager.forkFrom(
						input,
						directory,
						target,
						scenario === "fork-options" ? { id: "bad/id" } : undefined,
					),
				scenario === "fork-options"
					? /Session id must be non-empty/
					: scenario === "fork-directory" || scenario === "fork-stage"
						? /ENOTDIR/
						: scenario.endsWith("conversion")
							? /one-time conversion/
							: /Cannot fork: source session file is empty or invalid/,
				`attempt ${completed}`,
			);
		}
		if (acceptsScans) await setImmediate();
	}
	assert.deepEqual(view.data, body);
	for (const retained of [shallow[0], branch[0], tree[0]?.entry, foreignView]) {
		assert(retained?.type === "custom");
		assert.deepEqual(retained.data, body);
	}
	assert.equal(readFileSync(source, "utf8"), expected);
	assert.equal(readFileSync(rejected, "utf8"), rejectedBytes);
	assert.equal(readFileSync(blocked, "utf8"), "unrelated target bytes\n");
	assert.deepEqual(readdirSync(directory).sort(), beforeFiles);
	const fork = SessionManager.forkFrom(source, directory, directory, { id: "accepted-fork" });
	const copied = fork.getEntry("body");
	assert(copied?.type === "custom");
	assert.deepEqual(copied.data, body);
	assert.equal(fork.getHeader()?.parentSession, source);
	assert.equal(readFileSync(source, "utf8"), expected);
	console.log(JSON.stringify({ scenario, completed, sourceBytesMatchExpected: true, lazyBodiesUsable: true }));
} finally {
	if (scenario === "open-empty-readonly") chmodSync(rejected, 0o600);
}
