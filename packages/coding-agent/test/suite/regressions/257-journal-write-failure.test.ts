import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { openWorkingSession } from "../../../src/core/working-session.ts";
import { createHarness, type Harness } from "../harness.ts";

const sessionManagerUrl = pathToFileURL(resolve(import.meta.dirname, "../../../src/core/session-manager.ts")).href;

// A failed write cannot be undone in-process, so the failing writer runs under an 8 KiB file-size limit.
const failingWriter = `
import { chmodSync } from "node:fs";
import { SessionManager } from ${JSON.stringify(sessionManagerUrl)};
const session = SessionManager.create(process.argv[1], process.argv[1]);
const add = (content) => session.appendMessage({ role: "user", content, timestamp: 1 });
const codes = [];
const attempt = (write) => { try { write(); codes.push("ok"); } catch (error) { codes.push(error.code); } };
add("durable before");
chmodSync(session.getSessionFile(), 0o400);
attempt(() => add("small backlog"));
chmodSync(session.getSessionFile(), 0o600);
attempt(() => add("x".repeat(32 * 1024)));
attempt(() => session.flushWorkingSession());
console.log(JSON.stringify(codes));
`;

// The first write fails partway under a 4 KiB soft file-size limit. Recovery needs that limit lifted inside
// the same process, which only Linux allows (prlimit); the child restores its original limit itself.
const failingFirstWriter = `
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { SessionManager } from ${JSON.stringify(sessionManagerUrl)};
const [root, recovery] = process.argv.slice(1);
const prlimit = (...args) => execFileSync("prlimit", ["--pid=" + process.pid, ...args], { encoding: "utf8" }).trim();
const originalLimit = prlimit("--fsize", "--output=SOFT", "--noheadings", "--raw");
const session = SessionManager.create(root, root);
const add = (content) => session.appendMessage({ role: "user", content, timestamp: 1 });
const codes = [];
const attempt = (write) => { try { write(); codes.push("ok"); } catch (error) { codes.push(error.code); } };
session.appendModelChange("anthropic", "setup");
prlimit("--fsize=4096:");
attempt(() => add("x".repeat(8192)));
const partialBytes = statSync(session.getSessionFile()).size;
attempt(() => add("while limited"));
prlimit("--fsize=" + originalLimit + ":");
attempt(() => (recovery === "append" ? add("recovered") : session.flushWorkingSession()));
attempt(() => add("after recovery"));
const records = [session.getHeader(), ...session.getEntries()];
console.log(JSON.stringify({ codes, partialBytes, file: session.getSessionFile(), records }));
`;

const harnesses: Harness[] = [];
const roots: string[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// fitchmultz/pi#257: a failed retry of entries missed by an earlier failed append must leave a journal
// that reopens without duplicates and that native working-session save and restore accept.
it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
	"keeps the journal valid when retrying missed entries fails partway",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-257-partial-"));
		roots.push(root);
		const child = spawnSync(
			"/bin/sh",
			["-c", 'ulimit -f 8; exec "$0" --input-type=module -e "$1" "$2"', process.execPath, failingWriter, root],
			{ encoding: "utf8" },
		);
		expect(child.stderr).toBe("");
		expect(JSON.parse(child.stdout)).toEqual(["EACCES", "EFBIG", "EFBIG"]);

		const journal = join(root, readdirSync(root).find((name) => name.endsWith(".jsonl"))!);
		const manager = SessionManager.open(journal);
		const ids = manager.getEntries().map((entry) => entry.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(manager.buildSessionContext().messages).toMatchObject([{ content: "durable before" }]);

		const h = await createHarness({ sessionManager: manager });
		harnesses.push(h);
		const hold = await h.session.acquireWorkingSession();
		await hold.release();
		expect(openWorkingSession(hold.state).buildSessionContext()).toEqual(manager.buildSessionContext());
	},
);

// A failed first write leaves a partial journal that this session created. Later writes must rewrite it from
// accepted memory instead of failing with EEXIST, and the result must hold each accepted record exactly once.
it.runIf(process.platform === "linux").each([
	{ recovery: "append", messages: ["x".repeat(8192), "while limited", "recovered", "after recovery"] },
	{ recovery: "save", messages: ["x".repeat(8192), "while limited", "after recovery"] },
])("repairs a failed first journal write at the next $recovery once writable", ({ recovery, messages }) => {
	const root = mkdtempSync(join(tmpdir(), "pi-first-write-"));
	roots.push(root);
	const child = spawnSync(process.execPath, ["--input-type=module", "-e", failingFirstWriter, root, recovery], {
		encoding: "utf8",
	});
	expect(child.stderr).toBe("");
	const { codes, partialBytes, file, records } = JSON.parse(child.stdout);
	expect(partialBytes).toBe(4096);
	expect(codes).toEqual(["EFBIG", "EFBIG", "ok", "ok"]);
	expect(readFileSync(file, "utf8")).toBe(records.map((record: unknown) => `${JSON.stringify(record)}\n`).join(""));
	expect(SessionManager.open(file).buildSessionContext().messages).toMatchObject(
		messages.map((content) => ({ content })),
	);
});
