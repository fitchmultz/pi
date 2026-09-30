import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolvePath } from "../utils/paths.ts";
import {
	CURRENT_SESSION_VERSION,
	type SessionEntry,
	type SessionHeader,
	type SessionManager,
	writeSessionEntry,
} from "./session-manager.ts";

type TrailingEntries = (parentId: string | null, timestamp: string) => readonly object[];

function* sessionBranchRecords(
	sessionManager: SessionManager,
	createTrailingEntries?: TrailingEntries,
): Generator<{ entry: object; parentId?: string | null }> {
	const timestamp = new Date().toISOString();
	const header: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: sessionManager.getSessionId(),
		timestamp,
		cwd: sessionManager.getCwd(),
	};
	yield { entry: header };
	let parentId: string | null = null;
	for (const metadata of sessionManager.iterateEntryMetadata({ branchFrom: sessionManager.getLeafId() })) {
		yield { entry: sessionManager.getEntry(metadata.id)!, parentId };
		parentId = metadata.id;
	}
	for (const entry of createTrailingEntries?.(parentId, timestamp) ?? []) {
		yield { entry };
	}
}

/** Serialize the current branch and optional export-only entries as JSONL. */
export function serializeSessionBranch(
	sessionManager: SessionManager,
	createTrailingEntries?: TrailingEntries,
): string {
	// ponytail: this explicit string API needs enough heap/string space for the requested branch; file export streams it.
	return Array.from(
		sessionBranchRecords(sessionManager, createTrailingEntries),
		({ entry, parentId }) => `${JSON.stringify(parentId === undefined ? entry : { ...entry, parentId })}\n`,
	).join("");
}

/** Write the current session branch and optional export-only entries as JSONL. */
export function exportSessionToJsonl(
	sessionManager: SessionManager,
	outputPath?: string,
	createTrailingEntries?: TrailingEntries,
): string {
	const filePath = resolvePath(
		outputPath ?? `session-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
		process.cwd(),
	);
	const dir = dirname(filePath);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	// Serialize once, in order, before opening the destination: callbacks and toJSON can fail.
	const temporaryDirectory = mkdtempSync(join(tmpdir(), "pi-session-export-"));
	try {
		const spool = openSync(join(temporaryDirectory, "session.jsonl"), "w+", 0o600);
		try {
			for (const { entry, parentId } of sessionBranchRecords(sessionManager, createTrailingEntries)) {
				if (parentId === undefined) writeFileSync(spool, `${JSON.stringify(entry)}\n`);
				else writeSessionEntry(spool, entry as SessionEntry, { parentId });
			}

			// Unlike copyFileSync or rename, opening the destination preserves its mode and links.
			const fd = openSync(filePath, "w");
			try {
				const buffer = Buffer.allocUnsafe(64 * 1024);
				let position = 0;
				for (;;) {
					const bytesRead = readSync(spool, buffer, 0, buffer.length, position);
					if (bytesRead === 0) break;
					writeFileSync(fd, buffer.subarray(0, bytesRead));
					position += bytesRead;
				}
			} finally {
				closeSync(fd);
			}
		} finally {
			closeSync(spool);
		}
	} finally {
		rmSync(temporaryDirectory, { recursive: true, force: true });
	}
	return filePath;
}
