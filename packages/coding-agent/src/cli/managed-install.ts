import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

function existingRealPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

/** Only a runtime inside an owned, marked release may use the managed install selector. */
export function getActiveManagedInstallRoot(
	runtimePath: string,
	configuredRoot = process.env.PI_MANAGED_INSTALL_ROOT,
): string | undefined {
	const root = configuredRoot?.trim();
	if (!root) return undefined;

	const managedRoot = resolve(root);
	const releasesDir = existingRealPath(join(managedRoot, "releases"));
	// The launcher environment is inherited by child processes. A source checkout
	// or another Pi installation must not follow this managed install's selector.
	const releasePath = relative(releasesDir, existingRealPath(runtimePath));
	if (releasePath === ".." || releasePath.startsWith(`..${sep}`) || isAbsolute(releasePath)) return undefined;

	const markerPath = join(managedRoot, "managed-install.json");
	try {
		const marker = JSON.parse(readFileSync(markerPath, "utf8")) as {
			kind?: unknown;
			layout?: unknown;
			schemaVersion?: unknown;
		};
		if (marker.kind !== "pi-managed-install" || marker.schemaVersion !== 1 || marker.layout !== "releases-v1") {
			throw new Error();
		}
	} catch {
		throw new Error(`Managed install marker is missing or invalid: ${markerPath}`);
	}

	return managedRoot;
}
