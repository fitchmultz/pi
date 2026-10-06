#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

function run(command, args, options = {}) {
	console.log(`$ ${[command, ...args].join(" ")}`);
	const result = spawnSync(command, args, {
		encoding: "utf8",
		shell: process.platform === "win32",
		timeout: 300_000,
		...options,
	});
	if (result.status !== 0) {
		throw new Error(`Command failed: ${command} ${args.join(" ")}\n${result.stdout ?? ""}${result.stderr ?? ""}${result.error?.message ?? ""}`);
	}
	return result.stdout;
}

/**
 * Compatibility shim for fleet pack-fork.mjs.
 * Upstream replaced this module with package-artifacts.mjs; CI automation still
 * imports packReleasePackages from this path when packing a built fork.
 */
export function packReleasePackages(packages, tarballDirectory, { node = process.execPath, npm, env = process.env } = {}) {
	mkdirSync(tarballDirectory, { recursive: true });
	const tarballs = new Map();
	for (const pkg of packages) {
		const manifest = JSON.parse(readFileSync(join(pkg.directory, "package.json"), "utf8"));
		if (manifest.name !== pkg.name) throw new Error(`Unexpected package name in ${pkg.directory}`);
		const output = run(npm ? node : "npm", [
			...(npm ? [npm] : []), "pack", "--ignore-scripts", "--json", "--pack-destination", tarballDirectory,
		], { cwd: pkg.directory, env });
		// npm <11.6 returns an array; newer npm can return an object keyed by package name.
		const parsed = JSON.parse(output);
		const packed = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
		tarballs.set(pkg.name, join(tarballDirectory, packed.filename));
	}
	return tarballs;
}
