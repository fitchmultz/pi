import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./npm-audit.mjs", import.meta.url));
const zodAdvisory = "GHSA-mrhx-c7xc-m3w5";
const installLockPath = "packages/coding-agent/install-lock/package-lock.json";
const auditReport = {
	auditReportVersion: 2,
	vulnerabilities: {
		zod: {
			name: "zod",
			severity: "high",
			via: [{
				name: "zod",
				title: "Zod can exhaust memory while validating oversized constrained collections",
				url: `https://github.com/advisories/${zodAdvisory}`,
				severity: "high",
				range: "<4.6.6",
			}],
			nodes: ["node_modules/zod"],
			effects: ["@anthropic-ai/sandbox-runtime"],
		},
	},
};

async function audit(t, change = () => {}) {
	const root = await mkdtemp(join(tmpdir(), "pi-npm-audit-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
	const installLock = JSON.parse(await readFile(new URL(`../${installLockPath}`, import.meta.url), "utf8"));
	const report = structuredClone(auditReport);
	change({ lock, installLock, report });
	const bin = join(root, "bin");
	await mkdir(bin);
	await mkdir(join(root, "packages/coding-agent/install-lock"), { recursive: true });
	await writeFile(join(root, "package-lock.json"), JSON.stringify(lock));
	await writeFile(join(root, installLockPath), JSON.stringify(installLock));
	await writeFile(join(root, "audit.json"), JSON.stringify(report));
	// Only the registry response is stubbed; the public CLI evaluates the real locks.
	await writeFile(
		join(bin, "npm"),
		'#!/usr/bin/env node\nprocess.stdout.write(require("node:fs").readFileSync("audit.json"));\nprocess.exitCode = 1;\n',
		{ mode: 0o755 },
	);
	return spawnSync(process.execPath, [script], {
		cwd: root,
		env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` },
		encoding: "utf8",
	});
}

// The temporary executable stub uses a POSIX shebang.
const options = { skip: process.platform === "win32" };

test("accepts the reviewed workspace Zod graph", options, async (t) => {
	const result = await audit(t);
	assert.equal(result.status, 0, result.stderr);
	assert.ok(result.stdout.includes(`Accepted ${zodAdvisory}`), result.stdout);
});

test("does not pin unrelated development or extraneous lock entries", options, async (t) => {
	const result = await audit(t, ({ lock }) => {
		for (const [path, entry] of Object.entries(lock.packages)) {
			if (entry.extraneous) delete lock.packages[path];
		}
		lock.packages["node_modules/@cloudflare/vitest-plugin/node_modules/zod"].version = "4.6.7";
	});
	assert.equal(result.status, 0, result.stderr);
});

for (const [name, change] of [
	["a different Zod version", ({ lock }) => { lock.packages["node_modules/zod"].version = "4.6.5"; }],
	["a changed reviewed consumer", ({ lock }) => { lock.packages["node_modules/@anthropic-ai/sdk"].version = "0.134.0"; }],
	["a newly required SDK peer", ({ lock }) => {
		delete lock.packages["node_modules/@anthropic-ai/sdk"].peerDependenciesMeta.zod.optional;
	}],
	["an additional production Zod node", ({ lock }) => {
		lock.packages["node_modules/@anthropic-ai/sdk/node_modules/zod"] = { version: "3.25.76" };
	}],
	["Zod in the frozen consumer", ({ installLock }) => {
		installLock.packages["node_modules/example/node_modules/zod"] = { version: "3.25.76" };
	}],
	["missing frozen lock metadata", ({ installLock }) => { delete installLock.packages; }],
	["additional reported nodes", ({ report }) => { report.vulnerabilities.zod.nodes.push("node_modules/other/node_modules/zod"); }],
	["additional affected packages", ({ report }) => { report.vulnerabilities.zod.effects.push("other"); }],
	...["dependencies", "optionalDependencies", "peerDependencies"].map(section => [
		`an unreviewed ${section} consumer`,
		({ lock }) => {
			lock.packages["node_modules/unreviewed"] = { version: "1.0.0", [section]: { zod: "^3.25.0" } };
		},
	]),
]) {
	test(`rejects ${name}`, options, async (t) => {
		const result = await audit(t, change);
		assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
		assert.ok(result.stderr.includes(zodAdvisory), result.stderr);
		assert.ok(!result.stdout.includes(`Accepted ${zodAdvisory}`), result.stdout);
	});
}

test("still rejects unknown moderate advisories after accepting the reviewed Zod graph", options, async (t) => {
	const unknown = "GHSA-xxxx-yyyy-zzzz";
	const result = await audit(t, ({ report }) => {
		report.vulnerabilities.zod.via.push({
			name: "zod",
			url: `https://github.com/advisories/${unknown}`,
			title: "An unreviewed advisory",
			severity: "moderate",
		});
	});
	assert.equal(result.status, 1, result.stderr);
	assert.ok(result.stdout.includes(`Accepted ${zodAdvisory}`), result.stdout);
	assert.ok(result.stderr.includes(unknown), result.stderr);
});
