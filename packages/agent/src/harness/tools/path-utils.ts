import type { Context } from "../context.ts";
import type { ExecutionEnv } from "../types.ts";
import { getOrThrow } from "../types.ts";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const NARROW_NO_BREAK_SPACE = "\u202F";

export async function resolveToolPath(_env: ExecutionEnv, path: string, _context: Context): Promise<string> {
	// FileSystem operations accept relative paths. absolutePath is a lexical
	// storage/config API and would erase native symlink/.. traversal here.
	return path.startsWith("@") ? path.slice(1) : path;
}

export async function resolveReadToolPath(env: ExecutionEnv, path: string, context: Context): Promise<string> {
	const exact = await resolveToolPath(env, path, context);
	if (getOrThrow(await env.exists(exact, context))) return exact;
	const resolved = exact.replace(UNICODE_SPACES, " ");
	const variants = [
		resolved,
		resolved.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`),
		resolved.normalize("NFD"),
		resolved.replace(/'/g, "\u2019"),
		resolved.normalize("NFD").replace(/'/g, "\u2019"),
	];

	for (const variant of new Set(variants)) {
		if (getOrThrow(await env.exists(variant, context))) return variant;
	}
	return exact;
}
