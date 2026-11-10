// The hint added to a "not found" error: the nearest existing parent and its entries closest to the missing name.

import { readdir } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { pathExists } from "./path-utils.ts";

/** The lookups a hint needs. `LsOperations` and `FindOperations` already provide them. */
export interface MissingPathLookup {
	exists: (absolutePath: string) => Promise<boolean> | boolean;
	/** Entry names of a directory. A backend without it gets the parent alone. */
	readdir?: (absolutePath: string) => Promise<string[]> | string[];
}

/** The local filesystem, for tools that run without custom operations. */
export const localMissingPathLookup: MissingPathLookup = { exists: pathExists, readdir };

/**
 * How many entry names a hint lists. Measured on 30 days of session journals, in the 583 missing-path errors
 * whose next look-up used another entry of the nearest existing directory (median 40 entries): that entry
 * was among the 8 closest names in 43% of them, the 12 closest in 60% and the 20 closest in 72%.
 */
const LISTED_ENTRIES = 12;

/**
 * `message` followed by a line that tells what exists near the missing `absolutePath`: its nearest existing
 * parent and the names in it closest to the first missing part. The message alone when the path exists or no
 * parent does. Called only after a failure, so a successful call pays nothing.
 */
export async function withMissingPathHint(
	message: string,
	absolutePath: string,
	lookup: MissingPathLookup,
): Promise<string> {
	if (await lookup.exists(absolutePath)) return message;
	// The first missing part and the directory it was looked up in.
	let missing = absolutePath;
	let parent = dirname(missing);
	while (!(await lookup.exists(parent))) {
		if (dirname(parent) === parent) return message;
		missing = parent;
		parent = dirname(parent);
	}
	const found = `${message}\nNearest existing parent: ${parent}.`;
	if (!lookup.readdir) return found;
	let entries: string[];
	try {
		entries = await lookup.readdir(parent);
	} catch {
		// The parent is a file or cannot be listed.
		return found;
	}
	if (entries.length === 0) return `${found} It has no entries.`;
	const wanted = basename(missing);
	const closest = entries
		.map((name) => ({ name, distance: editDistance(wanted.toLowerCase(), name.toLowerCase()) }))
		.sort((a, b) => a.distance - b.distance || (a.name < b.name ? -1 : 1))
		.slice(0, LISTED_ENTRIES)
		.map((entry) => entry.name)
		.join(", ");
	return entries.length > LISTED_ENTRIES
		? `${found} Closest of its ${entries.length} entries to "${wanted}": ${closest}.`
		: `${found} Its entries: ${closest}.`;
}

/** Levenshtein distance: the single-character insertions, deletions and substitutions that turn `a` into `b`. */
function editDistance(a: string, b: string): number {
	let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		const current = [i];
		for (let j = 1; j <= b.length; j++) {
			current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
		}
		previous = current;
	}
	return previous[b.length];
}
