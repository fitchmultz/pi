import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { getPublicWorkspacePackages } from "./release-packages.mjs";
import { execNpmSync } from "./npm-command.mjs";

const manifestSchemaVersion = 1;

function isInsidePath(child, parent) {
	const relativePath = relative(parent, child);
	return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function getGitSource(repoRoot) {
	const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
	const status = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" });
	return { commit, dirty: status.length > 0 };
}

export function parseNpmPackOutput(output, expectedNames) {
	const expected = new Set(expectedNames);
	const parsed = JSON.parse(output);
	const entries = Array.isArray(parsed)
		? parsed.map((packed) => [packed?.name, packed])
		: parsed && typeof parsed === "object" ? Object.entries(parsed) : [];
	if (entries.length !== expected.size) throw new Error("npm pack returned an unexpected package count");
	const packedByName = new Map();
	const filenames = new Set();
	for (const [name, packed] of entries) {
		if (
			!expected.has(name) || packed?.name !== name || packedByName.has(name) ||
			typeof packed.filename !== "string" || !/^[^/\\]+\.tgz$/.test(packed.filename) ||
			filenames.has(packed.filename) || !Array.isArray(packed.files)
		) {
			throw new Error(`npm pack returned an unexpected result for ${name}`);
		}
		packedByName.set(name, packed);
		filenames.add(packed.filename);
	}
	return expectedNames.map((name) => packedByName.get(name));
}

export function packWorkspacePackages(packages, tarballDirectory, npmOptions = {}) {
	mkdirSync(tarballDirectory, { recursive: true });
	const expected = new Set();
	for (const pkg of packages) {
		const packageJson = JSON.parse(readFileSync(join(pkg.directory, "package.json"), "utf8"));
		if (packageJson.name !== pkg.name) throw new Error(`Unexpected package name in ${pkg.directory}`);
		if (expected.has(pkg.name)) throw new Error(`Duplicate package selected for packing: ${pkg.name}`);
		expected.add(pkg.name);
	}
	if (packages.length === 0) return [];
	const output = execNpmSync([
		"pack", ...packages.map((pkg) => pkg.directory),
		"--workspaces=false", "--ignore-scripts", "--json", "--pack-destination", tarballDirectory,
	], {
		...npmOptions,
		cwd: npmOptions.cwd ?? packages[0].directory,
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
		stdio: ["inherit", "pipe", "inherit"],
	});
	return parseNpmPackOutput(output, [...expected]);
}

function packPackages(repoRoot, packages, tarballDirectory, npmOptions) {
	const packed = packWorkspacePackages(packages, tarballDirectory, { ...npmOptions, cwd: repoRoot });
	return packages.map((pkg, index) => {
		const metadata = packed[index];
		const originalPath = join(tarballDirectory, metadata.filename);
		const contents = readFileSync(originalPath);
		const digest = createHash("sha512").update(contents).digest();
		const hash = digest.toString("hex").slice(0, 12);
		const tarballPath = originalPath.replace(/\.tgz$/, `-${hash}.tgz`);
		renameSync(originalPath, tarballPath);
		console.log(
			`  ${pkg.name}@${pkg.version}: ${metadata.files.length} files, ${metadata.size} bytes packed, ${metadata.unpackedSize} bytes unpacked`,
		);
		return {
			name: pkg.name,
			version: pkg.version,
			tarballPath,
			integrity: `sha512-${digest.toString("base64")}`,
		};
	});
}

function prepareOutputDirectory(outDir, options) {
	const repoRoot = resolve(options.repoRoot);
	if (!outDir) return mkdtempSync(join(tmpdir(), "pi-package-artifacts-"));
	const outputDirectory = resolve(outDir);
	if (dirname(outputDirectory) === outputDirectory || isInsidePath(repoRoot, outputDirectory)) {
		throw new Error(`Output directory must not be the repository, its ancestor, or a filesystem root: ${outputDirectory}`);
	}
	if (isInsidePath(outputDirectory, repoRoot) && !isInsidePath(outputDirectory, join(repoRoot, ".artifacts"))) {
		throw new Error(`Repository-local output directory must be inside ${join(repoRoot, ".artifacts")}: ${outputDirectory}`);
	}
	if (existsSync(outputDirectory)) {
		if (!options.force) throw new Error(`Output directory already exists. Use --force to replace it: ${outputDirectory}`);
		rmSync(outputDirectory, { force: true, recursive: true });
	}
	mkdirSync(outputDirectory, { recursive: true });
	return outputDirectory;
}

export function produceArtifactSet({ repoRoot, outDir, build = true, offlineModelData = false, force = false, source, npmOptions = {} }) {
	const root = resolve(repoRoot);
	const artifactDirectory = prepareOutputDirectory(outDir, { force, repoRoot: root });
	if (build) {
		execNpmSync(["run", "clean"], { ...npmOptions, cwd: root, stdio: "inherit" });
		execNpmSync(["run", offlineModelData ? "build:offline" : "build"], { ...npmOptions, cwd: root, stdio: "inherit" });
	}
	const artifactSource = source === undefined ? getGitSource(root) : source;
	const packages = getPublicWorkspacePackages(join(root, "packages"));
	const packedPackages = packPackages(root, packages, join(artifactDirectory, "tarballs"), npmOptions);
	const manifest = {
		schemaVersion: manifestSchemaVersion,
		source: artifactSource,
		packages: packedPackages
			.map(({ name, version, tarballPath, integrity }) => ({
				name,
				version,
				tarball: relative(artifactDirectory, tarballPath).replaceAll("\\", "/"),
				integrity,
			}))
			.sort((left, right) => left.name.localeCompare(right.name)),
	};
	const manifestPath = join(artifactDirectory, "manifest.json");
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
	return readArtifactSet(manifestPath);
}

export function readArtifactSet(manifestPath) {
	const absoluteManifestPath = resolve(manifestPath);
	const artifactDirectory = dirname(absoluteManifestPath);
	const manifest = JSON.parse(readFileSync(absoluteManifestPath, "utf8"));
	if (manifest.schemaVersion !== manifestSchemaVersion || !Array.isArray(manifest.packages)) {
		throw new Error(`Unsupported package artifact manifest: ${absoluteManifestPath}`);
	}
	const names = new Set();
	const packages = manifest.packages.map((pkg) => {
		if (
			typeof pkg?.name !== "string" ||
			typeof pkg.version !== "string" ||
			typeof pkg.tarball !== "string" ||
			typeof pkg.integrity !== "string"
		) {
			throw new Error(`Invalid package entry in artifact manifest: ${absoluteManifestPath}`);
		}
		if (names.has(pkg.name)) throw new Error(`Duplicate package in artifact manifest: ${pkg.name}`);
		names.add(pkg.name);
		const tarballPath = resolve(artifactDirectory, pkg.tarball);
		if (!isInsidePath(tarballPath, artifactDirectory) || !existsSync(tarballPath)) {
			throw new Error(`Missing package tarball for ${pkg.name}: ${tarballPath}`);
		}
		const integrity = `sha512-${createHash("sha512").update(readFileSync(tarballPath)).digest("base64")}`;
		if (integrity !== pkg.integrity) throw new Error(`Package tarball integrity mismatch for ${pkg.name}: ${tarballPath}`);
		return { ...pkg, tarballPath };
	});
	return {
		artifactDirectory,
		manifestPath: absoluteManifestPath,
		packages,
		source: manifest.source,
		getPackage(name) {
			const pkg = packages.find((candidate) => candidate.name === name);
			if (!pkg) throw new Error(`Package is not present in the artifact set: ${name}`);
			return pkg;
		},
	};
}
