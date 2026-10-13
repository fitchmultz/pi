import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { sha256, witness } from "../proof.mjs";

const mode = process.argv[2];
assert.ok(mode === "native" || mode === "fallback");
const payload = process.env.PI_PERF_ARTIFACT_REPO ?? process.env.PI_PERF_REPO;
const configuration = JSON.parse(readFileSync(join(payload, "biome.json"), "utf8"));
const configurationFiles = ["biome.json", ...(configuration.plugins ?? []).map((path) => normalize(path))];
function payloadHashes() {
	// Snapshot Git's complete payload inventory, not a second implementation of Biome's file scanner.
	const paths = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
		cwd: payload,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	}).split("\0");
	return Object.fromEntries(
		[...new Set([...paths.filter(Boolean), ...configurationFiles])]
			.sort()
			.map((path) => [path.replaceAll("\\", "/"), sha256(readFileSync(join(payload, path)))]),
	);
}
const fileHashes = payloadHashes();
const payloadSha256 = sha256(fileHashes);
console.log(JSON.stringify({ biomePayload: { payloadSha256, configurationFiles, fileHashes } }));
const started = performance.now();
const result = spawnSync(
	process.execPath,
	[
		...(mode === "fallback" ? ["--require", fileURLToPath(new URL("./force-android.cjs", import.meta.url))] : []),
		join(process.env.PI_PERF_REPO, "scripts/biome-check.mjs"),
	],
	{ cwd: payload, env: process.env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
);
const elapsedMs = performance.now() - started;
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
assert.equal(result.status, 0, result.error?.message);
assert.equal(sha256(payloadHashes()), payloadSha256, "Biome scan payload changed");
witness("biome", { mode, payloadSha256 }, { status: result.status });
console.log(JSON.stringify({ mode, elapsedMs }));
