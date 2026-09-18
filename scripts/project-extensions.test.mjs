import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const widget = jiti(resolve(".pi/extensions/prompt-url-widget.ts")).default;
const importRepro = jiti(resolve(".pi/extensions/import-repro.ts")).default;
const redraws = jiti(resolve(".pi/extensions/redraws.ts")).default;
const tps = jiti(resolve(".pi/extensions/tps.ts")).default;
const flush = () => new Promise((resolve) => setImmediate(resolve));

function widgetHarness() {
	const handlers = new Map();
	const pending = [];
	const writes = [];
	let name;
	widget({
		on: (event, handler) => handlers.set(event, handler),
		exec: () => new Promise((resolve) => pending.push(resolve)),
		getSessionName: () => name,
		setSessionName: (value) => { name = value; writes.push(["name", value]); },
	});
	const ctx = {
		hasUI: true, cwd: "/fixture",
		ui: { setWidget: (_key, value) => writes.push(["widget", value]) },
		sessionManager: { getEntries: () => [] },
	};
	return { handlers, pending, writes, ctx };
}

test("prompt widget ignores deferred metadata after shutdown", async () => {
	const h = widgetHarness();
	await h.handlers.get("before_agent_start")({ prompt: "Analyze GitHub issue(s): https://github.com/a/b/issues/1" }, h.ctx);
	await h.handlers.get("session_shutdown")?.({ reason: "resume" }, h.ctx);
	const before = h.writes.length;
	h.pending[0]({ code: 0, stdout: '{"title":"late title"}' });
	await flush();
	assert.equal(h.writes.length, before);
	assert.equal(h.handlers.has("session_switch"), false);
});

test("prompt widget ignores an older request after a newer prompt", async () => {
	const h = widgetHarness();
	for (const id of [1, 2]) {
		await h.handlers.get("before_agent_start")({ prompt: `Analyze GitHub issue(s): https://github.com/a/b/issues/${id}` }, h.ctx);
	}
	h.pending[1]({ code: 0, stdout: '{"title":"new title"}' });
	await flush();
	const before = h.writes.length;
	h.pending[0]({ code: 0, stdout: '{"title":"old title"}' });
	await flush();
	assert.equal(h.writes.length, before);
});

test("prompt widget applies metadata while active and restores on session_start", async () => {
	const h = widgetHarness();
	h.ctx.sessionManager.getEntries = () => [{ type: "message", message: { role: "user", content: "Analyze GitHub issue(s): https://github.com/a/b/issues/1" } }];
	await h.handlers.get("session_start")({ reason: "resume" }, h.ctx);
	h.pending[0]({ code: 0, stdout: '{"title":"current title"}' });
	await flush();
	assert.equal(h.writes.at(-1)[1], "Issue: current title (https://github.com/a/b/issues/1)");
});

for (const outcome of ["cancel", "success", "callback-error", "switch-error"]) {
	test(`import repro uses the live notification context: ${outcome}`, async () => {
		// Retain these faux journals as evidence; never touch real session history.
		const root = mkdtempSync(join(tmpdir(), "pi-import-repro-fixture-"));
		const sessions = join(root, "sessions");
		mkdirSync(sessions);
		const source = join(root, "source.jsonl");
		const sourceCwd = process.platform === "win32" ? "/ci/repo" : "C:\\ci\\repo";
		const original = `${JSON.stringify({ type: "session", id: "fixture", cwd: sourceCwd })}\n`;
		writeFileSync(source, original);
		let command;
		importRepro({ registerCommand: (_name, definition) => { command = definition; } });
		let stale = false;
		const oldNotices = [];
		const freshNotices = [];
		const messages = [];
		const next = {
			ui: { notify: (...args) => freshNotices.push(args) },
			sendMessage: async (message) => {
				if (outcome === "callback-error") throw new Error("post-switch failure");
				messages.push(message);
			},
		};
		await command.handler(source, {
			sessionManager: { getCwd: () => root, getSessionDir: () => sessions },
			ui: { notify: (...args) => { assert.equal(stale, false, "old context used after switch"); oldNotices.push(args); } },
			switchSession: async (_file, options) => {
				if (outcome === "switch-error") throw new Error("pre-switch failure");
				if (outcome === "cancel") return { cancelled: true };
				stale = true;
				await options.withSession(next);
				return { cancelled: false };
			},
		});
		assert.equal(readFileSync(source, "utf8"), original);
		assert.equal(JSON.parse(readFileSync(join(sessions, "source.jsonl"), "utf8")).cwd, root);
		assert.equal(messages.length, outcome === "success" ? 1 : 0);
		assert.deepEqual(freshNotices, outcome === "callback-error" ? [["ir: post-switch failure", "error"]] : []);
		if (outcome === "switch-error") assert.deepEqual(oldNotices.at(-1), ["ir: pre-switch failure", "error"]);
	});
}

test("redraw stats currently report zero when RPC does not invoke custom UI", async () => {
	let command;
	redraws({ registerCommand: (_name, definition) => { command = definition; } });
	const notices = [];
	await command.handler("", { hasUI: true, mode: "rpc", ui: { custom: async () => undefined, notify: (...args) => notices.push(args) } });
	assert.deepEqual(notices, [["TUI full redraws: 0", "info"]]);
});

test("TPS reports each low-level run separately across retries", (t) => {
	const handlers = new Map();
	tps({ on: (event, handler) => handlers.set(event, handler) });
	let now = 1000;
	t.mock.method(Date, "now", () => now);
	const notices = [];
	const ctx = { hasUI: true, ui: { notify: (message) => notices.push(message) } };
	for (const output of [10, 20]) {
		handlers.get("agent_start")();
		now += 1000;
		handlers.get("agent_end")({ messages: [{ role: "assistant", usage: { input: 2, output, cacheRead: 0, cacheWrite: 0, totalTokens: output + 2 } }] }, ctx);
	}
	assert.deepEqual(notices, [
		"TPS 10.0 tok/s. out 10, in 2, cache r/w 0/0, total 12, 1.0s",
		"TPS 20.0 tok/s. out 20, in 2, cache r/w 0/0, total 22, 1.0s",
	]);
});
