import {
	closeSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readlinkSync,
	readSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { resolvePath } from "../utils/paths.ts";
import { CURRENT_SESSION_VERSION, type SessionHeader, type SessionManager } from "./session-manager.ts";

type TrailingEntries = (parentId: string | null, timestamp: string) => readonly object[];

function* sessionBranchLines(
	sessionManager: SessionManager,
	createTrailingEntries?: TrailingEntries,
): Generator<string> {
	const timestamp = new Date().toISOString();
	const header: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: sessionManager.getSessionId(),
		timestamp,
		cwd: sessionManager.getCwd(),
	};
	yield `${JSON.stringify(header)}\n`;
	let parentId: string | null = null;
	for (const entry of sessionManager.getBranch()) {
		yield `${JSON.stringify({ ...entry, parentId })}\n`;
		parentId = entry.id;
	}
	for (const entry of createTrailingEntries?.(parentId, timestamp) ?? []) {
		yield `${JSON.stringify(entry)}\n`;
	}
}

/** Serialize the current branch and optional export-only entries as JSONL. */
export function serializeSessionBranch(
	sessionManager: SessionManager,
	createTrailingEntries?: TrailingEntries,
): string {
	return Array.from(sessionBranchLines(sessionManager, createTrailingEntries)).join("");
}

function resolveExportFileTarget(filePath: string): string {
	let target = resolvePath(filePath);
	const links = new Set<string>();
	for (;;) {
		let parent: string;
		try {
			parent = realpathSync.native(dirname(target));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return target;
			throw error;
		}
		target = join(parent, basename(target));
		if (!lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) return target;
		if (links.has(target)) throw new Error(`Symlink cycle: ${target}`);
		links.add(target);
		target = resolve(parent, readlinkSync(target));
	}
}

/** A pending journal has no inode, so check the actual destination directory's case behavior. */
function directoryIgnoresCase(directory: string): boolean {
	const probe = mkdtempSync(join(directory, ".pi-export-case-"));
	try {
		const original = statSync(probe);
		const alternate = statSync(join(directory, basename(probe).replace(".pi-", ".PI-")), {
			throwIfNoEntry: false,
		});
		return alternate?.dev === original.dev && alternate?.ino === original.ino;
	} finally {
		rmSync(probe, { recursive: true, force: true });
	}
}

export function assertDistinctExportTarget(sourceFile: string | undefined, outputPath: string): void {
	if (!sourceFile) return;
	const samePath = resolvePath(sourceFile) === resolvePath(outputPath);
	const source = statSync(sourceFile, { throwIfNoEntry: false });
	const output = statSync(outputPath, { throwIfNoEntry: false });
	let samePendingTarget = false;
	if (!source) {
		const sourceTarget = resolveExportFileTarget(sourceFile);
		const outputTarget = resolveExportFileTarget(outputPath);
		samePendingTarget = sourceTarget === outputTarget;
		if (
			!samePendingTarget &&
			!output &&
			basename(sourceTarget).normalize("NFD").toLowerCase() === basename(outputTarget).normalize("NFD").toLowerCase()
		) {
			const sourceParent = statSync(dirname(sourceTarget), { throwIfNoEntry: false });
			const outputParent = statSync(dirname(outputTarget), { throwIfNoEntry: false });
			if (
				sourceParent &&
				outputParent &&
				sourceParent.dev === outputParent.dev &&
				sourceParent.ino === outputParent.ino
			) {
				samePendingTarget = directoryIgnoresCase(dirname(sourceTarget));
			}
		}
	}
	if (samePath || (source && output && source.dev === output.dev && source.ino === output.ino) || samePendingTarget) {
		throw new Error(`Cannot export over the source session file: ${outputPath}`);
	}
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
	assertDistinctExportTarget(sessionManager.getSessionFile(), filePath);
	const dir = dirname(filePath);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	// Serialize once, in order, before opening the destination: callbacks and toJSON can fail.
	const temporaryDirectory = mkdtempSync(join(tmpdir(), "pi-session-export-"));
	try {
		const spool = openSync(join(temporaryDirectory, "session.jsonl"), "w+", 0o600);
		try {
			for (const line of sessionBranchLines(sessionManager, createTrailingEntries)) {
				writeFileSync(spool, line);
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
