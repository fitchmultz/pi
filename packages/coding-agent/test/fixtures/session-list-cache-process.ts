import fs, { appendFileSync, unlinkSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { basename } from "node:path";
import { type SessionListProgress, SessionManager } from "../../src/core/session-manager.ts";

let journalReads = 0;
let journalBytes = 0;
let journalPath = "";
const mode = process.argv[3];
const fixtureModes = [
	"crash-before-cache-publish",
	"delete-on-cache-publish",
	"unavailable-date-context",
	"timezone-during-list",
];
const rename = fsPromises.rename;
if (mode === "crash-before-cache-publish") {
	fsPromises.rename = async () => process.exit(23);
} else if (mode === "delete-on-cache-publish") {
	fsPromises.rename = async (...args: Parameters<typeof rename>) => {
		unlinkSync(journalPath);
		return rename(...args);
	};
} else if (mode === "unavailable-date-context") {
	Intl.DateTimeFormat = new Proxy(Intl.DateTimeFormat, {
		apply() {
			throw new Error("unavailable date context");
		},
		construct() {
			throw new Error("unavailable date context");
		},
	});
}
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
		});
		if (mode && !fixtureModes.includes(mode)) {
			stream.once("end", () => appendFileSync(String(args[0]), mode));
		}
	}
	return stream;
};
syncBuiltinESMExports();
const sessions = await SessionManager.listAll(process.argv[2], onProgress);
console.log(JSON.stringify({ sessions, journalReads, journalBytes }));
