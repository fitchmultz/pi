import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { produceArtifactSet } from "/pi-performance-source/scripts/package-artifacts.mjs";
import { getPublicWorkspacePackages } from "/pi-performance-source/scripts/release-packages.mjs";
import { witness } from "../proof.mjs";

const repo = process.env.PI_PERF_REPO;
const payload = process.env.PI_PERF_ARTIFACT_REPO ?? repo;
const packages = getPublicWorkspacePackages(join(payload, "packages"));
assert.equal(packages.length, 10);
const mode = process.argv[2];
function outputHashes() {
	return Object.fromEntries(
		packages.map((pkg) => {
			const hash = createHash("sha512");
			let files = 0;
			function visit(directory, prefix = "") {
				for (const name of readdirSync(directory).sort()) {
					const path = join(directory, name);
					const entry = statSync(path);
					if (entry.isDirectory()) visit(path, `${prefix}${name}/`);
					else {
						hash.update(`${prefix}${name}\0${entry.mode & 0o777}\0`).update(readFileSync(path));
						files++;
					}
				}
			}
			visit(join(pkg.directory, "dist"));
			return [pkg.name, { files, sha512: hash.digest("hex") }];
		}),
	);
}
if (mode === "build") {
	assert.equal(payload, repo, "Build must use its measured source root");
	for (const pkg of packages) rmSync(join(pkg.directory, "dist"), { recursive: true, force: true });
	const started = performance.now();
	const result = spawnSync(process.execPath, [join(repo, "scripts/build.mjs"), "--offline"], {
		cwd: repo,
		env: process.env,
		stdio: ["ignore", "inherit", "inherit"],
	});
	const elapsedMs = performance.now() - started;
	assert.equal(result.status, 0, result.error?.message);
	const hashes = outputHashes();
	console.log(JSON.stringify({ mode, elapsedMs, packages: packages.length, hashes }));
	witness(mode, { packages: packages.map((pkg) => pkg.name) }, hashes);
} else if (mode === "pack") {
	const inputHashes = outputHashes();
	const scratch = mkdtempSync(join(tmpdir(), "pi-pack-"));
	try {
		const started = performance.now();
		const artifacts = produceArtifactSet({
			repoRoot: payload,
			outDir: join(scratch, "output"),
			build: false,
			source: null,
			npmOptions: { env: { ...process.env, npm_config_offline: "true", npm_config_ignore_scripts: "true" } },
		});
		const elapsedMs = performance.now() - started;
		const hashes = Object.fromEntries(
			artifacts.packages.map((pkg) => [
				pkg.name,
				createHash("sha512").update(readFileSync(pkg.tarballPath)).digest("hex"),
			]),
		);
		assert.equal(artifacts.packages.length, packages.length);
		console.log(JSON.stringify({ mode, elapsedMs, packages: packages.length, hashes }));
		witness(mode, inputHashes, { manifest: JSON.parse(readFileSync(artifacts.manifestPath, "utf8")), hashes });
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
} else throw new Error("Expected build or pack");
