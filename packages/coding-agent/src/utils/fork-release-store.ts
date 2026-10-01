import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** Called under the selector lock, before any release-store mutation. */
export function claimForkReleaseStore(releases: string, selector: string): void {
	// Resolve parent aliases, not the selector symlink pointing at a changing runtime.
	const canonicalSelector = join(realpathSync(dirname(selector)), basename(selector));
	const store = resolve(releases);
	mkdirSync(store, { recursive: true });
	const ownerFile = join(store, ".owner-selector");
	const temporary = join(store, `.owner-selector.${randomUUID()}.tmp`);
	try {
		writeFileSync(temporary, `${canonicalSelector}\n`, { flag: "wx" });
		try {
			// Publish complete contents without overwriting another selector's first claim.
			linkSync(temporary, ownerFile);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	} finally {
		rmSync(temporary, { force: true });
	}
	const owner = readFileSync(ownerFile, "utf8");
	if (owner !== `${canonicalSelector}\n`) {
		throw new Error(
			`Release store ${store} is owned by selector ${owner.trimEnd()}, not ${canonicalSelector}. Use a separate release store with --releases for this selector.`,
		);
	}
}
