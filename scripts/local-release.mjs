#!/usr/bin/env node
import { execFileSync } from "node:child_process";

import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { installConsumer, packageConsumerDirectoryName, smokeTestNpmConsumer } from "./local-package-install.mjs";
import { produceArtifactSet } from "./package-artifacts.mjs";
import { codingAgentName, smokeTestCodingAgent } from "./coding-agent-smoke.mjs";
import { execNpmSync } from "./npm-command.mjs";

function printUsage() {
	console.log(`Usage: node scripts/local-release.mjs [options]

Builds and packs the publishable packages, then installs the tarballs into
isolated directories outside the repository for local release testing.

Options:
  --out <dir>          Output directory. Defaults to a new directory under ${tmpdir()}
  --force              Remove --out first if it already exists
  --skip-check         Do not run npm run check before building
  --skip-test          Do not run ./test.sh after building
  --skip-install       Only create the artifact set; do not create isolated installs
  --skip-bun-install   Do not create the isolated Bun install
  --help               Show this help
`);
}

function currentBinaryPlatform() {
	if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
	if (process.platform === "linux") return process.arch === "arm64" ? "linux-arm64" : "linux-x64";
	throw new Error(`Unsupported binary platform: ${process.platform} ${process.arch}`);
}

function buildBunBinaryRelease(targetDirectory, archiveDirectory) {
	const platform = currentBinaryPlatform();
	const binaryBuildDirectory = join(archiveDirectory, "binary-build");
	execFileSync("bash", ["./scripts/build-binaries.sh",
		"--skip-install",
		"--skip-build",
		"--platform",
		platform,
		"--out",
		binaryBuildDirectory,
	], { stdio: "inherit" });
	rmSync(targetDirectory, { force: true, recursive: true });
	cpSync(join(binaryBuildDirectory, platform), targetDirectory, { recursive: true });
	const archiveName = `pi-${platform}.tar.gz`;
	cpSync(join(binaryBuildDirectory, archiveName), join(archiveDirectory, archiveName));
	return platform;
}

function createPiShim(installDirectory) {
	symlinkSync(join("node_modules", ".bin", "pi"), join(installDirectory, "pi"));
}

const { values } = parseArgs({
	options: {
		force: { type: "boolean", default: false },
		help: { type: "boolean", default: false },
		out: { type: "string" },
		"skip-bun-install": { type: "boolean", default: false },
		"skip-check": { type: "boolean", default: false },
		"skip-install": { type: "boolean", default: false },
		"skip-test": { type: "boolean", default: false },
	},
});
if (values.help) {
	printUsage();
	process.exit(0);
}
const options = {
	force: values.force,
	outDir: values.out,
	skipBunInstall: values["skip-bun-install"],
	skipCheck: values["skip-check"],
	skipInstall: values["skip-install"],
	skipTest: values["skip-test"],
};
const repoRoot = process.cwd();
const rootPackageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
if (rootPackageJson.name !== "pi-monorepo") throw new Error("Run this script from the repository root");

execNpmSync(["run", "generate:models"], { cwd: repoRoot, stdio: "inherit" });
if (!options.skipCheck) execNpmSync(["run", "check"], { cwd: repoRoot, stdio: "inherit" });

const artifactSet = produceArtifactSet({
	build: true,
	force: options.force,
	offlineModelData: true,
	outDir: options.outDir,
	repoRoot,
});
const outDir = artifactSet.artifactDirectory;
const binaryDirectory = join(outDir, "bun");
const nodeInstallDirectory = join(outDir, "node");
const bunInstallDirectory = join(outDir, "bun-install");

if (!options.skipTest) execFileSync("bash", ["./test.sh"], { cwd: repoRoot, stdio: "inherit" });

let binaryPlatform;
if (!options.skipInstall) {
	binaryPlatform = buildBunBinaryRelease(binaryDirectory, outDir);
	const validationRoot = mkdtempSync(join(tmpdir(), "pi-local-release-consumers-"));
	try {
		for (const pkg of artifactSet.packages) {
			const directory = pkg.name === codingAgentName
				? nodeInstallDirectory
				: join(validationRoot, "npm", packageConsumerDirectoryName(pkg.name));
			installConsumer({ artifactSet, directory, packageNames: [pkg.name] });
			smokeTestNpmConsumer({ artifactSet, directory, packageName: pkg.name });
			if (pkg.name === codingAgentName) smokeTestCodingAgent(directory);
		}
		createPiShim(nodeInstallDirectory);

		if (!options.skipBunInstall) {
			installConsumer({ artifactSet, directory: bunInstallDirectory, packageManager: "bun", packageNames: [codingAgentName] });
			smokeTestCodingAgent(bunInstallDirectory, "bun");
			createPiShim(bunInstallDirectory);
		}
	} finally {
		rmSync(validationRoot, { force: true, recursive: true });
	}
}

console.log(`\nLocal release artifacts created: ${outDir}`);
console.log(`Manifest: ${artifactSet.manifestPath}`);
console.log("\nTarballs:");
for (const pkg of artifactSet.packages) console.log(`  ${pkg.tarballPath}`);

if (!options.skipInstall) {
	console.log("\nLocal Bun binary release:");
	console.log(`  ${binaryDirectory}`);
	console.log(`  ${join(outDir, `pi-${binaryPlatform}.tar.gz`)}`);
	console.log("\nRun the local Bun binary release from outside the repository:");
	console.log(`  ${join(binaryDirectory, "pi")} --help`);

	console.log("\nIsolated npm install:");
	console.log(`  ${nodeInstallDirectory}`);
	console.log("\nRun the locally packed npm CLI from outside the repository:");
	console.log(`  ${join(nodeInstallDirectory, "pi")} --help`);

	if (!options.skipBunInstall) {
		console.log("\nIsolated Bun package install:");
		console.log(`  ${bunInstallDirectory}`);
		console.log("\nRun the locally packed Bun package CLI from outside the repository:");
		console.log(`  ${join(bunInstallDirectory, "pi")} --help`);
	}
}
