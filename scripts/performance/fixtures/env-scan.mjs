import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { witness } from "../proof.mjs";

const repo = process.env.PI_PERF_REPO;
const crate = mkdtempSync(join(tmpdir(), "pi-scan-crate-"));
try {
	mkdirSync(join(crate, "src"));
	const daemon = join(repo, "packages/env/daemon");
	for (const name of ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml"])
		copyFileSync(join(daemon, name), join(crate, name));
	const toolchain = readFileSync(join(crate, "rust-toolchain.toml"), "utf8").match(/channel\s*=\s*"([^"]+)"/)?.[1];
	assert.ok(toolchain, "Missing pinned Rust toolchain");
	const source = readFileSync(fileURLToPath(new URL("./env-scan.rs", import.meta.url)), "utf8");
	writeFileSync(
		join(crate, "src/main.rs"),
		source.replace(
			/#\[path = "\/pi-performance-source([^"]+)"\]/g,
			(_match, suffix) => `#[path = ${JSON.stringify(repo.replaceAll("\\", "/") + suffix)}]`,
		),
	);
	// Setup is separate from reported scanner intervals. Reuse only the selected revision's locked deps.
	const setup = spawnSync(
		"cargo",
		[`+${toolchain}`, "build", "--release", "--locked", "--offline", "--manifest-path", join(crate, "Cargo.toml")],
		{
			env: {
				...process.env,
				CARGO_HOME: process.env.PI_PERF_CARGO_HOME,
				RUSTUP_HOME: process.env.PI_PERF_RUSTUP_HOME,
			},
			encoding: "utf8",
		},
	);
	assert.equal(setup.status, 0, setup.error?.message ?? setup.stderr);
	const result = spawnSync(
		join(crate, "target/release", process.platform === "win32" ? "pi-env.exe" : "pi-env"),
		process.argv.slice(2),
		{ encoding: "utf8" },
	);
	assert.equal(result.status, 0, result.error?.message ?? result.stderr);
	process.stdout.write(result.stdout);
	const rows = result.stdout
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const semantic = rows.map(({ ms, allocations, allocatedBytes, ...value }) => value);
	witness("rust", { args: process.argv.slice(2), toolchain }, semantic);
} finally {
	rmSync(crate, { recursive: true, force: true });
}
