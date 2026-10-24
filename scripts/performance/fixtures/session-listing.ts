import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { performance } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { setKeybindings } from "/pi-performance-source/packages/tui/src/index.ts";
import { KeybindingsManager } from "/pi-performance-source/packages/coding-agent/src/core/keybindings.ts";
import { getDefaultSessionDir, SessionManager } from "/pi-performance-source/packages/coding-agent/src/core/session-manager.ts";
import { SessionSelectorComponent } from "/pi-performance-source/packages/coding-agent/src/modes/interactive/components/session-selector.ts";
import { filterAndSortSessions } from "/pi-performance-source/packages/coding-agent/src/modes/interactive/components/session-selector-search.ts";
import { initTheme } from "/pi-performance-source/packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { witness } from "../proof.mjs";

const files = Number(process.argv[2] ?? 12);
const rows = Number(process.argv[3] ?? 128);
const payloadBytes = Number(process.argv[4] ?? 16384);
assert(files > 0 && rows > 0 && payloadBytes > 0);
const agentDir = process.env.PI_CODING_AGENT_DIR;
assert(agentDir, "runner must isolate the agent directory");
const fixture = mkdtempSync(join(tmpdir(), "pi-listing-synthetic-"));
const stamp = "2026-10-24T00:00:00.000Z";
const text = "public synthetic text λ😀 ".repeat(16);
const toolText = "x".repeat(payloadBytes);
const paths: string[] = [];
let bytes = 0;
for (let file = 0; file < files; file++) {
	const cwd = join(fixture, `project-${file % 4}`);
	const dir = getDefaultSessionDir(cwd, agentDir);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `session-${file}.jsonl`);
	paths.push(path);
	const entries = [JSON.stringify({ type: "session", version: 3, id: `session-${file}`, timestamp: stamp, cwd })];
	for (let row = 0; row < rows; row++) {
		entries.push(JSON.stringify({
			type: "message", id: `m${row}`, parentId: row === 0 ? null : `m${row - 1}`, timestamp: stamp,
			message: row % 8 === 0
				? { role: "user", content: `${text} needle ${file} row ${row}`, timestamp: 1792800000000 + file }
				: { role: "toolResult", toolCallId: `call-${row}`, toolName: "read", content: [{ type: "text", text: toolText }], isError: false, timestamp: 1792800000000 },
		}));
	}
	entries.push(JSON.stringify({ type: "session_info", id: "name", parentId: `m${rows - 1}`, timestamp: stamp, name: `Synthetic ${file}` }));
	writeFileSync(path, `${entries.join("\n")}\n`, { mode: 0o600 });
	bytes += statSync(path).size;
}

const profiler = process.env.PI_LISTING_CPU_PROFILE ? new Session() : undefined;
profiler?.connect();
if (profiler) {
	await profiler.post("Profiler.enable");
	await profiler.post("Profiler.start");
}
const coldStart = performance.now();
const cold = await SessionManager.listAll();
const coldMs = performance.now() - coldStart;
if (profiler) {
	const { profile } = await profiler.post("Profiler.stop");
	writeFileSync(process.env.PI_LISTING_CPU_PROFILE!, JSON.stringify(profile));
	profiler.disconnect();
}
const warmStart = performance.now();
const warm = await SessionManager.listAll();
const warmMs = performance.now() - warmStart;
assert.deepEqual(warm, cold);
assert.equal(warm.length, files);
assert(warm.every((info) => info.messageCount === rows && info.name === `Synthetic ${info.id.split("-")[1]}`));
const currentStart = performance.now();
const current = await SessionManager.list(join(fixture, "project-0"));
const currentMs = performance.now() - currentStart;
assert.equal(current.length, Math.ceil(files / 4));
const query = `"needle ${files - 1} row ${rows - 8}"`;
const expected = paths[files - 1];
assert.deepEqual(filterAndSortSessions(warm, query, "recent").map((info) => info.path), [expected]);

initTheme("dark");
const keybindings = new KeybindingsManager();
setKeybindings(keybindings);
let loaded = false;
let selected: string | undefined;
let progressUpdates = 0;
let partialUpdates = 0;
const pickerStart = performance.now();
const picker = new SessionSelectorComponent(
	async () => [],
	async (progress, signal) => {
		const result = await SessionManager.listAll((count, total, partial) => {
			progressUpdates++;
			if (partial) partialUpdates++;
			progress?.(count, total, partial);
		}, signal);
		loaded = true;
		return result;
	},
	(path) => { selected = path; },
	() => {}, () => {}, () => {}, { keybindings },
);
await setImmediate();
picker.getSessionList().handleInput("\t");
const deadline = performance.now() + 30000;
while (!loaded && performance.now() < deadline) await setImmediate();
assert(loaded, "actual picker loader must settle");
await setImmediate();
picker.getSessionList().handleInput(query);
const rendered = picker.render(140).join("\n");
assert(!rendered.includes("Loading"));
picker.getSessionList().handleInput("\r");
const pickerMs = performance.now() - pickerStart;
assert.equal(selected, expected);
assert.equal(progressUpdates, files);
assert(partialUpdates > 0);
const output = warm.map((info) => ({ ...info, path: basename(info.path), cwd: info.cwd.replace(fixture, "<fixture>") }));
witness("session-listing", { files, rows, payloadBytes, bytes }, { output, selected: files - 1, current: current.length });
console.log(JSON.stringify({ files, rows, payloadBytes, bytes, coldMs, warmMs, currentMs, pickerMs, sessions: warm.length, messages: warm.reduce((sum, info) => sum + info.messageCount, 0), searchCharacters: warm.reduce((sum, info) => sum + info.allMessagesText.length, 0), progressUpdates, partialUpdates, errors: 0 }));
