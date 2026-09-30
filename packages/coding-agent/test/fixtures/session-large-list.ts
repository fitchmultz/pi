import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { setKeybindings } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SessionSelectorComponent } from "../../src/modes/interactive/components/session-selector.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";

const directory = process.argv[2]!;
const source = join(directory, "history.jsonl");
const timestamp = "2026-09-01T00:00:00.000Z";
const header = { type: "session", version: 3, id: "large-list", cwd: directory, timestamp };
const body = "first message ".padEnd(2 * 1024 * 1024, "a");
const fd = openSync(source, "wx", 0o600);
try {
	writeFileSync(fd, `${JSON.stringify(header)}\n`);
	for (let index = 0; index < 64; index++) {
		writeFileSync(
			fd,
			`${JSON.stringify({
				type: "message",
				id: `m${index}`,
				parentId: index ? `m${index - 1}` : null,
				timestamp,
				message: { role: "user", content: body, timestamp: index },
			})}\n`,
		);
	}
	writeFileSync(
		fd,
		`${JSON.stringify({
			type: "compaction",
			id: "compact",
			parentId: "m63",
			timestamp,
			summary: "tiny active context",
			firstKeptEntryId: "compact",
			tokensBefore: 1000,
		})}\n`,
	);
} finally {
	closeSync(fd);
}
function digest(): string {
	const handle = openSync(source, "r");
	const hash = createHash("sha256");
	const buffer = Buffer.allocUnsafe(64 * 1024);
	try {
		for (;;) {
			const count = readSync(handle, buffer, 0, buffer.length, null);
			if (!count) return hash.digest("hex");
			hash.update(buffer.subarray(0, count));
		}
	} finally {
		closeSync(handle);
	}
}
const before = digest();
const manager = SessionManager.open(source);
assert.equal(manager.getEntryCount(), 65);
assert.equal(manager.buildSessionContext().messages.length, 1);
const sessions = await SessionManager.list(directory, directory);
const all = await SessionManager.listAll(directory);
assert.equal(sessions.length, 1);
assert.equal(all.length, 1);
assert.equal(sessions[0]!.id, "large-list");
assert.equal(sessions[0]!.messageCount, 64);
initTheme("dark");
setKeybindings(new KeybindingsManager());
let selected: string | undefined;
const selector = new SessionSelectorComponent(
	async () => sessions,
	async () => all,
	(path) => {
		selected = path;
	},
	() => {},
	() => {},
	() => {},
);
await setImmediate();
assert(selector.render(100).join("\n").includes("first message"));
selector.handleInput("\r");
assert.equal(selected, source);
assert.equal(sessions[0]!.firstMessagePreview, body.slice(0, 256));
assert.equal(sessions[0]!.firstMessage, body);
assert.equal(digest(), before);
assert(global.gc, "Run with --expose-gc to measure retained listing memory");
global.gc();
process.stdout.write(
	`${JSON.stringify({ bytes: statSync(source).size, entries: manager.getEntryCount(), retainedHeap: process.memoryUsage().heapUsed })}\n`,
);
