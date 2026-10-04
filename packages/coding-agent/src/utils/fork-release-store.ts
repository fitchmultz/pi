import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** Called under the selector lock, before any release-store mutation. */
export function claimForkReleaseStore(releases: string, selector: string): string {
	// Resolve parent aliases, not the selector symlink pointing at a changing runtime.
	const canonicalSelector = join(realpathSync(dirname(selector)), basename(selector));
	const store = resolve(releases);
	mkdirSync(store, { recursive: true });
	const ownerFile = join(store, ".owner-selector");
	try {
		// Exclusive creation works on Termux, where Android denies hard links.
		writeFileSync(ownerFile, `${canonicalSelector}\n`, { flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	// ponytail: an interrupted first write leaves an invalid claim; verify its owner before repairing it.
	const owner = readFileSync(ownerFile, "utf8");
	if (owner !== `${canonicalSelector}\n`) {
		throw new Error(
			`Release store ${store} is owned by selector ${owner.trimEnd()}, not ${canonicalSelector}. Use a separate release store with --releases for this selector.`,
		);
	}
	return canonicalSelector;
}
