import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolvePath } from "../utils/paths.ts";
import { CURRENT_SESSION_VERSION, type SessionHeader, type SessionManager } from "./session-manager.ts";

/** Write the current session branch and optional trailing export-only entries as JSONL. */
export function exportSessionToJsonl(
	sessionManager: SessionManager,
	outputPath?: string,
	createTrailingEntries?: (parentId: string | null, timestamp: string) => readonly object[],
): string {
	const filePath = resolvePath(
		outputPath ?? `session-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
		process.cwd(),
	);
	const dir = dirname(filePath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	const timestamp = new Date().toISOString();
	const header: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: sessionManager.getSessionId(),
		timestamp,
		cwd: sessionManager.getCwd(),
	};
	// Serialize once, in order, before opening the destination: callbacks and toJSON can fail.
	const temporaryDirectory = mkdtempSync(join(tmpdir(), "pi-session-export-"));
	try {
		const spool = openSync(join(temporaryDirectory, "session.jsonl"), "w+", 0o600);
		try {
			writeFileSync(spool, `${JSON.stringify(header)}\n`);
			let parentId: string | null = null;
			for (const entry of sessionManager.getBranch()) {
				writeFileSync(spool, `${JSON.stringify({ ...entry, parentId })}\n`);
				parentId = entry.id;
			}
			for (const entry of createTrailingEntries?.(parentId, timestamp) ?? []) {
				writeFileSync(spool, `${JSON.stringify(entry)}\n`);
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
