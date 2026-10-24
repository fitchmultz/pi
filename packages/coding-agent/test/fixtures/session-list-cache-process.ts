import fs, { appendFileSync, unlinkSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { SessionManager } from "../../src/core/session-manager.ts";

let journalReads = 0;
let journalBytes = 0;
let journalPath = "";
const rename = fsPromises.rename;
if (process.argv[3] === "crash-before-cache-publish") {
	fsPromises.rename = async () => process.exit(23);
} else if (process.argv[3] === "delete-on-cache-publish") {
	fsPromises.rename = async (...args: Parameters<typeof rename>) => {
		unlinkSync(journalPath);
		return rename(...args);
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
		if (process.argv[3] && !["delete-on-cache-publish", "crash-before-cache-publish"].includes(process.argv[3])) {
			stream.once("end", () => appendFileSync(String(args[0]), process.argv[3]));
		}
	}
	return stream;
};
syncBuiltinESMExports();
const sessions = await SessionManager.listAll(process.argv[2]);
console.log(JSON.stringify({ sessions, journalReads, journalBytes }));
