import type { Context } from "../context.ts";
import type { ExecutionEnv } from "../types.ts";
import { getOrThrow } from "../types.ts";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const NARROW_NO_BREAK_SPACE = "\u202F";

export async function resolveReadToolPath(env: ExecutionEnv, path: string, context: Context): Promise<string> {
	if (getOrThrow(await env.exists(path, context))) return path;
	const resolved = path.replace(UNICODE_SPACES, " ");
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
	return path;
}
