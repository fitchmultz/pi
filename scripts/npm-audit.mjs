// Runs `npm audit --omit=dev` and fails on advisories at or above the audit
// level, except for advisories that were reviewed and accepted below. Every
// accepted advisory must name the affected package and explain why it does not
// apply. Remove an entry once a fixed version is installed; the script warns
// about entries that no longer match.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const auditLevel = "moderate";
const severities = ["info", "low", "moderate", "high", "critical"];

function reviewedWorkspaceZod(vulnerability) {
	if (
		vulnerability.nodes?.length !== 1 ||
		vulnerability.nodes[0] !== "node_modules/zod" ||
		vulnerability.effects?.length !== 1 ||
		vulnerability.effects[0] !== "@anthropic-ai/sandbox-runtime"
	) return false;

	try {
		const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
		const installLock = JSON.parse(readFileSync("packages/coding-agent/install-lock/package-lock.json", "utf8"));
		if (
			lock.lockfileVersion !== 3 || installLock.lockfileVersion !== 3 ||
			!lock.packages?.[""] || !installLock.packages?.[""]
		) return false;

		const production = Object.entries(lock.packages).filter(([, entry]) => !entry.dev && !entry.extraneous);
		const isZod = ([path, entry]) => /(?:^|\/)node_modules\/zod$/.test(path) || entry.name === "zod";
		const zodNodes = production.filter(isZod);
		if (
			zodNodes.length !== 1 || zodNodes[0][0] !== "node_modules/zod" ||
			zodNodes[0][1].version !== "3.25.76"
		) return false;
		if (Object.entries(installLock.packages).some(isZod)) return false;

		const sections = ["dependencies", "optionalDependencies", "peerDependencies"];
		const consumers = production.filter(([, entry]) =>
			sections.some(section => Object.hasOwn(entry[section] ?? {}, "zod")),
		);
		const reviewed = {
			"node_modules/@anthropic-ai/sandbox-runtime": { version: "0.0.26", dependencies: "^3.24.1" },
			"node_modules/@anthropic-ai/sdk": { version: "0.133.0", peerDependencies: "^3.25.0 || ^4.0.0" },
			"packages/ai/node_modules/openai": { version: "7.32.0", peerDependencies: "^3.25 || ^4.0" },
		};
		return consumers.length === Object.keys(reviewed).length && consumers.every(([path, entry]) => {
			const expected = reviewed[path];
			return expected !== undefined && expected.version === entry.version &&
				sections.every(section => entry[section]?.zod === expected[section]) &&
				entry.peerDependenciesMeta?.zod?.optional === (expected.peerDependencies ? true : undefined);
		});
	} catch {
		return false;
	}
}

/**
 * @type {Record<string, {
 *   package: string;
 *   reason: string;
 *   matches?: (vulnerability: { nodes?: string[]; effects?: string[] }) => boolean;
 * }>}
 */
const acceptedAdvisories = {
	"GHSA-86w9-cpqp-85rv": {
		package: "node-forge",
		reason:
			"No fixed node-forge release exists. It is only reachable through @earendil-works/gondolin in the private, " +
			"unpublished gondolin example extension. Gondolin only verifies leaf certificates against its own locally " +
			"generated CA (public exponent 65537), so the low-exponent signature forgery does not apply.",
	},
	"GHSA-mrhx-c7xc-m3w5": {
		package: "zod",
		matches: reviewedWorkspaceZod,
		reason:
			"Accepted only for the checked source-workspace Zod 3.25.76 graph; the frozen coding-agent consumer contains no Zod. " +
			"Pi's sandbox example calls SandboxManager.initialize(), which does not parse Zod, and Pi does not use the SDK Zod helpers. " +
			"Zod PR6652 only short-circuits constrained collections: unbounded standalone srt parsing is not fixed or declared safe. " +
			"This acceptance does not cover installed/global extensions or other Zod graphs.",
	},
};

const result = spawnSync("npm", ["audit", "--omit=dev", "--json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
if (result.error) {
	throw result.error;
}

let report;
try {
	report = JSON.parse(result.stdout);
} catch {
	process.stderr.write(result.stderr);
	process.stderr.write(result.stdout);
	console.error("npm audit did not produce a JSON report.");
	process.exit(1);
}

if (report.error) {
	console.error(`npm audit failed: ${report.error.summary ?? JSON.stringify(report.error)}`);
	process.exit(1);
}

const minimumSeverity = severities.indexOf(auditLevel);
const seenAccepted = new Set();
const failures = new Map();

for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
	for (const via of vulnerability.via) {
		// String entries point at another vulnerable package, which is reported on its own.
		if (typeof via === "string") {
			continue;
		}
		const id = via.url?.split("/").pop() ?? String(via.source);
		const accepted = acceptedAdvisories[id];
		if (accepted && accepted.package === via.name && (!accepted.matches || accepted.matches(vulnerability))) {
			seenAccepted.add(id);
			continue;
		}
		if (severities.indexOf(via.severity) >= minimumSeverity) {
			failures.set(`${id}:${via.name}`, via);
		}
	}
}

for (const id of seenAccepted) {
	console.log(`Accepted ${id} (${acceptedAdvisories[id].package}): ${acceptedAdvisories[id].reason}`);
}

for (const id of Object.keys(acceptedAdvisories)) {
	if (!seenAccepted.has(id)) {
		console.log(`::warning::Accepted advisory ${id} no longer matches; review or remove it from scripts/npm-audit.mjs.`);
	}
}

if (failures.size > 0) {
	console.error(`\nFound ${failures.size} unaccepted advisories at or above ${auditLevel}:`);
	for (const via of failures.values()) {
		console.error(`- ${via.name} ${via.range} [${via.severity}] ${via.title} ${via.url}`);
	}
	process.exit(1);
}

console.log(`No unaccepted advisories at or above ${auditLevel}.`);
