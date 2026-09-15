#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	allowedInstallScriptPackages,
	collectDependencyPackages,
	getInternalWorkspaces,
	internalPackageNames,
	internalPackagePrefix,
	packageDependencies,
	packageNameFromLockPath,
	readJson,
	resolveExternalDependency,
	sortedObject,
	sortedPackageEntry,
} from "./coding-agent-lock-helpers.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const codingAgentDir = join(repoRoot, "packages/coding-agent");
const outputDir = join(codingAgentDir, "install-lock");
const rootLockfilePath = join(repoRoot, "package-lock.json");
const outputPackageJsonPath = join(outputDir, "package.json");
const outputLockfilePath = join(outputDir, "package-lock.json");

const installPackageName = "@earendil-works/pi-coding-agent-install";

const args = new Set(process.argv.slice(2));
const checkOnly = args.has("--check");

for (const arg of args) {
	if (arg !== "--check") {
		console.error(`Unknown argument: ${arg}`);
		process.exit(1);
	}
}

function isExactVersionSpec(spec) {
	return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(spec);
}

function createInstallerPackageJson(codingAgentPackage) {
	const packageJson = {
		name: installPackageName,
		version: codingAgentPackage.version,
		private: true,
		description: "Lockfile root used by the Pi installer and updater.",
		dependencies: {
			[codingAgentPackage.name]: codingAgentPackage.version,
		},
	};
	if (codingAgentPackage.overrides) {
		packageJson.overrides = codingAgentPackage.overrides;
	}
	if (codingAgentPackage.engines) {
		packageJson.engines = codingAgentPackage.engines;
	}
	return packageJson;
}

function createRootLockEntry(installerPackageJson) {
	const entry = {
		name: installerPackageJson.name,
		version: installerPackageJson.version,
		dependencies: installerPackageJson.dependencies,
	};
	if (installerPackageJson.engines) {
		entry.engines = installerPackageJson.engines;
	}
	return sortedPackageEntry(entry);
}

function validateGeneratedFiles(installerPackageJson, installLock, internalNames) {
	const errors = [];
	const rootEntry = installLock.packages[""];
	const includedPackageNames = new Set();
	const seenAllowedInstallScriptPackages = new Set();

	if (installLock.lockfileVersion !== 3) {
		errors.push("package-lock.json must use lockfileVersion 3");
	}
	if (installLock.name !== installerPackageJson.name) {
		errors.push(`lockfile name ${installLock.name} does not match package.json name ${installerPackageJson.name}`);
	}
	if (installLock.version !== installerPackageJson.version) {
		errors.push(
			`lockfile version ${installLock.version} does not match package.json version ${installerPackageJson.version}`,
		);
	}
	if (JSON.stringify(rootEntry?.dependencies ?? {}) !== JSON.stringify(installerPackageJson.dependencies)) {
		errors.push("lockfile root dependencies do not match package.json dependencies");
	}

	for (const [lockPath, entry] of Object.entries(installLock.packages)) {
		const packageName = packageNameFromLockPath(lockPath);
		if (packageName) {
			includedPackageNames.add(packageName);
		}
		if (entry.link) {
			errors.push(`${lockPath} is a link entry`);
		}
		if (typeof entry.resolved === "string" && /^(file:|link:|workspace:|\.\.?\/|\/)/.test(entry.resolved)) {
			errors.push(`${lockPath} has a local resolved value: ${entry.resolved}`);
		}
		if (entry.dev || entry.devOptional || entry.extraneous) {
			errors.push(`${lockPath || "root"} contains dev/extraneous metadata`);
		}
		if (
			packageName !== undefined &&
			(packageName.startsWith(internalPackagePrefix) || internalPackageNames.has(packageName)) &&
			entry.version !== installerPackageJson.version
		) {
			errors.push(`${lockPath} internal package version ${entry.version} does not match ${installerPackageJson.version}`);
		}
		if (entry.hasInstallScript) {
			if (!packageName || !entry.version) {
				errors.push(`${lockPath || "root"} has install scripts but no package name/version`);
			} else {
				const packageId = `${packageName}@${entry.version}`;
				if (allowedInstallScriptPackages.has(packageId)) {
					seenAllowedInstallScriptPackages.add(packageId);
				} else {
					errors.push(
						`${lockPath} has install scripts (${packageId}). Review it and add it to allowedInstallScriptPackages if intentional.`,
					);
				}
			}
		}
	}

	for (const packageId of allowedInstallScriptPackages.keys()) {
		if (!seenAllowedInstallScriptPackages.has(packageId)) {
			errors.push(`allowed install-script package ${packageId} is no longer present; remove it from the allowlist`);
		}
	}

	for (const name of internalNames) {
		if (!includedPackageNames.has(name)) {
			errors.push(`internal dependency ${name} is missing`);
		}
	}

	for (const [lockPath, entry] of Object.entries(installLock.packages)) {
		for (const [dependencyName, dependencySpec] of Object.entries(packageDependencies(entry))) {
			let dependencyLockPath;
			try {
				dependencyLockPath = resolveExternalDependency(installLock.packages, dependencyName, lockPath);
			} catch {
				errors.push(`${lockPath || "root"} dependency ${dependencyName} is missing`);
				continue;
			}

			const dependencyEntry = installLock.packages[dependencyLockPath];
			if (isExactVersionSpec(dependencySpec) && dependencyEntry.version !== dependencySpec) {
				errors.push(
					`${lockPath || "root"} dependency ${dependencyName}@${dependencySpec} resolves to ${dependencyEntry.version}`,
				);
			}
		}
	}

	const platformPackageCount = Object.values(installLock.packages).filter((entry) => entry.os || entry.cpu || entry.libc)
		.length;
	if (platformPackageCount === 0) {
		errors.push("no platform-specific optional dependency entries found");
	}

	if (errors.length > 0) {
		throw new Error(`Generated installer lock failed validation:\n${errors.map((error) => `  - ${error}`).join("\n")}`);
	}
}

function generateInstallLock() {
	const rootLock = readJson(rootLockfilePath);
	if (rootLock.lockfileVersion !== 3 || !rootLock.packages) {
		throw new Error("package-lock.json must be lockfileVersion 3 and contain a packages map");
	}

	const lockPackages = rootLock.packages;
	const codingAgentPackage = readJson(join(codingAgentDir, "package.json"));
	const installerPackageJson = createInstallerPackageJson(codingAgentPackage);
	const internalWorkspaces = getInternalWorkspaces(lockPackages, repoRoot);
	const installLockPackages = {
		"": createRootLockEntry(installerPackageJson),
	};
	const queue = Object.keys(packageDependencies(installerPackageJson)).map((name) => ({
		name,
		sourceFrom: "",
	}));

	const internalNames = collectDependencyPackages(lockPackages, internalWorkspaces, installLockPackages, queue);

	const installLock = {
		name: installerPackageJson.name,
		version: installerPackageJson.version,
		lockfileVersion: 3,
		requires: true,
		packages: sortedObject(installLockPackages),
	};

	validateGeneratedFiles(installerPackageJson, installLock, internalNames);
	return { installerPackageJson, installLock };
}

try {
	const { installerPackageJson, installLock } = generateInstallLock();
	const packageJsonContent = `${JSON.stringify(installerPackageJson, null, "\t")}\n`;
	const lockfileContent = `${JSON.stringify(installLock, null, "\t")}\n`;

	if (checkOnly) {
		if (!existsSync(outputPackageJsonPath) || !existsSync(outputLockfilePath)) {
			console.error("packages/coding-agent/install-lock is missing generated files.");
			console.error("Run: npm run install-lock:coding-agent");
			process.exit(1);
		}
		const currentPackageJson = readFileSync(outputPackageJsonPath, "utf8");
		const currentLockfile = readFileSync(outputLockfilePath, "utf8");
		if (currentPackageJson !== packageJsonContent || currentLockfile !== lockfileContent) {
			console.error("packages/coding-agent/install-lock is out of date.");
			console.error("Run: npm run install-lock:coding-agent");
			process.exit(1);
		}
		console.log("packages/coding-agent/install-lock is up to date.");
	} else {
		mkdirSync(outputDir, { recursive: true });
		writeFileSync(outputPackageJsonPath, packageJsonContent);
		writeFileSync(outputLockfilePath, lockfileContent);
		const packageCount = Object.keys(installLock.packages).length - 1;
		const platformPackageCount = Object.values(installLock.packages).filter((entry) => entry.os || entry.cpu || entry.libc)
			.length;
		console.log(
			`Wrote packages/coding-agent/install-lock/package.json and package-lock.json (${packageCount} packages, ${platformPackageCount} platform-specific).`,
		);
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
