import assert from "node:assert/strict";
import { chmodSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "../../src/core/session-manager.ts";

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
const manager = SessionManager.inMemory(directory);
manager.setSessionFile(source);
const view = manager.getEntry("body");
assert(view?.type === "custom");

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
try {
	for (; completed < 320; completed++) {
		if (scenario === "resume-empty") {
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
	}
	assert.deepEqual(view.data, body);
	assert.equal(readFileSync(source, "utf8"), original);
	assert.equal(readFileSync(rejected, "utf8"), rejectedBytes);
	assert.equal(readFileSync(blocked, "utf8"), "unrelated target bytes\n");
	assert.deepEqual(readdirSync(directory).sort(), beforeFiles);
	const fork = SessionManager.forkFrom(source, directory, directory, { id: "accepted-fork" });
	const copied = fork.getEntry("body");
	assert(copied?.type === "custom");
	assert.deepEqual(copied.data, body);
	assert.equal(fork.getHeader()?.parentSession, source);
	assert.equal(readFileSync(source, "utf8"), original);
	console.log(JSON.stringify({ scenario, completed, sourceBytesUnchanged: true, lazyBodiesUsable: true }));
} finally {
	if (scenario === "open-empty-readonly") chmodSync(rejected, 0o600);
}
