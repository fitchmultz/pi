import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { openWorkingSession } from "../../../src/core/working-session.ts";
import { createHarness, type Harness } from "../harness.ts";

const sessionManagerSource = resolve(import.meta.dirname, "../../../src/core/session-manager.ts");

// A failed write cannot be undone in-process, so the failing writer runs under an 8 KiB file-size limit.
const failingWriter = `
import { chmodSync } from "node:fs";
const { SessionManager } = await import(process.argv[1]);
const session = SessionManager.create(process.argv[2], process.argv[2]);
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
			[
				"-c",
				'ulimit -f 8; exec "$0" --input-type=module -e "$1" "$2" "$3"',
				process.execPath,
				failingWriter,
				sessionManagerSource,
				root,
			],
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
