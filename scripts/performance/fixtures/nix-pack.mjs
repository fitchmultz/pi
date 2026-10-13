import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { witness } from "../proof.mjs";

const repo = process.env.PI_PERF_REPO;
const payload = process.env.PI_PERF_ARTIFACT_REPO ?? repo;
const names = ["chord", "telemetry", "ai", "tui", "agent", "codemode", "mcp", "coding-agent"];
const driver = join(repo, "scripts/pack-nix-packages.mjs");
const scratch = mkdtempSync(join(tmpdir(), "pi-nix-pack-"));
try {
	const output = join(scratch, "output");
	const inputHashes = Object.fromEntries(
		names.map((name) => [
			name,
			createHash("sha256")
				.update(readFileSync(join(payload, "packages", name, "package.json")))
				.digest("hex"),
		]),
	);
	const started = performance.now();
	if (existsSync(driver)) {
		assert.equal(payload, repo, "Nix driver derives its root; use the after root as --artifact-repo");
		execFileSync(process.execPath, [driver, output, ...names], {
			cwd: repo,
			env: process.env,
			stdio: ["ignore", "inherit", "inherit"],
		});
	} else {
		// Exact legacy public Nix install recipe; no source copy or synthetic packing implementation.
		mkdirSync(output);
		const temporary = join(scratch, "npm-output");
		mkdirSync(temporary);
		for (const name of names) {
			const filename = execFileSync(
				"npm",
				["pack", "--ignore-scripts", "--silent", "--pack-destination", temporary],
				{ cwd: join(payload, "packages", name), env: process.env, encoding: "utf8" },
			).trim();
			renameSync(join(temporary, filename), join(output, `${name}.tgz`));
		}
	}
	const elapsedMs = performance.now() - started;
	assert.deepEqual(readdirSync(output).sort(), names.map((name) => `${name}.tgz`).sort());
	const hashes = Object.fromEntries(
		names.map((name) => [
			name,
			createHash("sha512")
				.update(readFileSync(join(output, `${name}.tgz`)))
				.digest("hex"),
		]),
	);
	console.log(JSON.stringify({ mode: existsSync(driver) ? "native-driver" : "legacy-recipe", elapsedMs, hashes }));
	witness("nix-pack", inputHashes, hashes);
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
