import fs, { appendFileSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { basename } from "node:path";
import readline from "node:readline";
import { type SessionInfo, type SessionListProgress, SessionManager } from "../../src/core/session-manager.ts";

let journalReads = 0;
let journalBytes = 0;
let journalParses = 0;
let journalScans = 0;
let journalPath = "";
let streamEndRewrites = 0;
const mode = process.argv[3];
const fixtureModes = [
	"crash-before-cache-publish",
	"delete-on-cache-publish",
	"unavailable-date-context",
	"transient-date-context",
	"timezone-during-list",
	"timezone-at-stream-end",
	"timezone-during-scan",
	"freeze-revision",
	"rewrite-at-stream-end",
	"abort-during-read",
];
const controller = mode === "abort-during-read" ? new AbortController() : undefined;
const rename = fsPromises.rename;
if (mode === "crash-before-cache-publish") {
	fsPromises.rename = async () => process.exit(23);
} else if (mode === "delete-on-cache-publish") {
	fsPromises.rename = async (...args: Parameters<typeof rename>) => {
		unlinkSync(journalPath);
		return rename(...args);
	};
} else if (mode === "unavailable-date-context" || mode === "transient-date-context") {
	let failures = mode === "unavailable-date-context" ? Infinity : 1;
	Intl.DateTimeFormat = new Proxy(Intl.DateTimeFormat, {
		apply(target, thisArg, args) {
			if (failures-- > 0) throw new Error("unavailable date context");
			return Reflect.apply(target, thisArg, args);
		},
		construct(target, args, newTarget) {
			if (failures-- > 0) throw new Error("unavailable date context");
			return Reflect.construct(target, args, newTarget);
		},
	});
}
if (mode === "freeze-revision" || mode === "rewrite-at-stream-end") {
	// Portable model of the actual native MAP_SHARED reproduction in the Python
	// fixture. Keep inode/device/size real, freeze only timestamps across readers.
	const statSync = fs.statSync;
	Object.defineProperty(fs, "statSync", {
		value: (...args: Parameters<typeof statSync>) => {
			const stats = statSync(...args);
			if (stats && String(args[0]).endsWith(".jsonl") && "mtimeNs" in stats) {
				stats.mtimeNs = 0n;
				stats.ctimeNs = 0n;
			}
			return stats;
		},
	});
}
const parse = JSON.parse;
JSON.parse = (text, reviver) => {
	const result = parse(text, reviver);
	if (result && typeof result === "object" && typeof result.type === "string") {
		journalParses++;
		if (mode === "timezone-during-scan" && result.type === "message") {
			process.env.TZ = result.id === "first" ? "America/Los_Angeles" : "UTC";
		}
	}
	return result;
};
const createInterface = readline.createInterface;
readline.createInterface = ((...args: Parameters<typeof createInterface>) => {
	const input = (args[0] as { input?: { path?: unknown } }).input;
	if (String(input?.path).endsWith(".jsonl")) journalScans++;
	return createInterface(...args);
}) as typeof createInterface;
let onProgress: SessionListProgress | undefined;
if (mode === "timezone-during-list") {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const readFile = fsPromises.readFile;
	fsPromises.readFile = (async (...args: Parameters<typeof readFile>) => {
		if (basename(String(args[0])) === "a.json") await gate;
		return readFile(...args);
	}) as typeof readFile;
	onProgress = () => {
		process.env.TZ = "America/Los_Angeles";
		release();
	};
}
const createReadStream = fs.createReadStream;
fs.createReadStream = (...args: Parameters<typeof createReadStream>) => {
	const stream = createReadStream(...args);
	if (String(args[0]).endsWith(".jsonl")) {
		journalReads++;
		journalPath = String(args[0]);
		stream.on("data", (chunk: string | Buffer) => {
			journalBytes += Buffer.byteLength(chunk);
			controller?.abort();
		});
		if (mode === "rewrite-at-stream-end") {
			stream.once("end", () => {
				if (streamEndRewrites++) return;
				const before = readFileSync(String(args[0]), "utf8");
				const after = before.replaceAll("old name", "new name").replaceAll("old text", "new text");
				if (before === after || Buffer.byteLength(before) !== Buffer.byteLength(after)) {
					throw new Error("stream-end rewrite must change bytes without changing size");
				}
				writeFileSync(String(args[0]), after);
			});
		} else if (mode === "timezone-at-stream-end") {
			stream.once("end", () => {
				process.env.TZ = "America/Los_Angeles";
			});
		} else if (mode && !fixtureModes.includes(mode)) {
			stream.once("end", () => appendFileSync(String(args[0]), mode));
		}
	}
	return stream;
};
syncBuiltinESMExports();
let sessions: SessionInfo[] | undefined;
let aborted = false;
try {
	sessions =
		process.argv[4] === "list"
			? await SessionManager.list(process.argv[5], process.argv[2], onProgress, controller?.signal)
			: await SessionManager.listAll(process.argv[2], onProgress, controller?.signal);
} catch (error) {
	if (!controller?.signal.aborted || !(error instanceof Error) || error.name !== "AbortError") throw error;
	aborted = true;
}
console.log(
	JSON.stringify({ sessions, journalReads, journalBytes, journalParses, journalScans, streamEndRewrites, aborted }),
);
