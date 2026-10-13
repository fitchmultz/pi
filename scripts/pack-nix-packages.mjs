#!/usr/bin/env node

import { readFileSync, realpathSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packWorkspacePackages } from "./package-artifacts.mjs";

const [output, ...names] = process.argv.slice(2);
if (!output || names.length === 0 || new Set(names).size !== names.length || names.some((name) => !/^[a-z0-9-]+$/.test(name))) {
	throw new Error("Usage: node scripts/pack-nix-packages.mjs OUTPUT PACKAGE_DIRECTORY...");
}
const root = realpathSync.native(fileURLToPath(new URL("../", import.meta.url)));
const packages = names.map((name) => {
	const directory = join(root, "packages", name);
	const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
	if (manifest.private === true) throw new Error(`Cannot pack private workspace: ${name}`);
	return { directory, name: manifest.name, version: manifest.version };
});
const tarballDirectory = resolve(output);
const packed = packWorkspacePackages(packages, tarballDirectory, { cwd: root });
for (const [index, pkg] of packed.entries()) {
	renameSync(join(tarballDirectory, pkg.filename), join(tarballDirectory, `${names[index]}.tgz`));
}
