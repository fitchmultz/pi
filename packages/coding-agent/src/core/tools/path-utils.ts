import { accessSync, constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveLocalOperationPath } from "@earendil-works/pi-agent-core/node";
import { normalizePath } from "../../utils/paths.ts";

const NARROW_NO_BREAK_SPACE = "\u202F";

function tryCurlyQuoteVariant(filePath: string): string {
	// macOS uses U+2019 (right single quotation mark) in screenshot names like "Capture d'écran"
	// Users typically type U+0027 (straight apostrophe)
	return filePath.replace(/'/g, "\u2019");
}

function fileExists(filePath: string): boolean {
	try {
		accessSync(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

export async function pathExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

// fd/rg's --no-require-git also removes nested repository boundaries (#5960).
// Use it only outside Git; leave ignore-file parsing to the native tools.
export async function isInsideGitRepo(searchPath: string): Promise<boolean> {
	for (let current = await realpath(searchPath).catch(() => searchPath); ; ) {
		if (await pathExists(resolveLocalOperationPath(current, ".git"))) return true;
		const parent = dirname(current);
		if (parent === current) return false;
		current = parent;
	}
}

export function expandPath(filePath: string): string {
	return normalizePath(filePath, { normalizeUnicodeSpaces: true, stripAtPrefix: true });
}

/**
 * Resolve a path relative to the given cwd.
 * Handles ~ expansion and absolute paths without changing literal filename characters.
 */
export function resolveToCwd(filePath: string, cwd: string): string {
	return resolveLocalOperationPath(cwd, normalizePath(filePath, { expandTilde: false }));
}

// Filename conveniences are read-only fallbacks, never preferred over an exact path.
function* readPathFallbacks(filePath: string, cwd: string): Generator<string> {
	const resolved = resolveLocalOperationPath(
		cwd,
		normalizePath(filePath, { normalizeUnicodeSpaces: true, expandTilde: false }),
	);
	yield resolved;

	const nfdVariant = resolved.normalize("NFD");
	for (const variant of [
		resolved.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`),
		nfdVariant,
		tryCurlyQuoteVariant(resolved),
		tryCurlyQuoteVariant(nfdVariant),
	]) {
		if (variant !== resolved) yield variant;
	}
}

export function resolveReadPath(filePath: string, cwd: string): string {
	const exact = resolveToCwd(filePath, cwd);
	if (fileExists(exact)) return exact;
	for (const candidate of readPathFallbacks(filePath, cwd)) {
		if (fileExists(candidate)) return candidate;
	}
	return exact;
}

export async function resolveReadPathAsync(filePath: string, cwd: string): Promise<string> {
	const exact = resolveToCwd(filePath, cwd);
	if (await pathExists(exact)) return exact;
	for (const candidate of readPathFallbacks(filePath, cwd)) {
		if (await pathExists(candidate)) return candidate;
	}
	return exact;
}
