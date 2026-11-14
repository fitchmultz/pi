#!/usr/bin/env node
/**
 * Entry points are cost contracts.
 *
 * A package's `exports` map is the only place that says which modules are public, and one stray
 * `export *` can silently make a narrow entry drag an entire barrel: importing a 1-file pure
 * function through a barrel costs ~37 MB of evaluated module graph, and nothing fails until someone
 * measures a process. This walks the value-import graph of every declared entry point and enforces a
 * budget per entry, so that regression fails at commit time instead.
 *
 * Only value imports count. `import type` / `export type` are erased before Node sees them.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Workspace package name -> its source root, so cross-package imports are followed. */
const WORKSPACE = {
	"@earendil-works/chord": "packages/chord/src",
	"@earendil-works/pi-ai": "packages/ai/src",
	"@earendil-works/pi-durable": "packages/durable/src",
	"@earendil-works/pi-agent-core": "packages/agent/src",
	"@earendil-works/pi-codemode": "packages/codemode/src",
	"@earendil-works/pi-telemetry": "packages/telemetry/src",
	"@earendil-works/pi-mcp": "packages/mcp/src",
	"@earendil-works/pi-schema": "packages/schema/src",
	"@earendil-works/pi-tui": "packages/tui/src",
};

/**
 * Budgets are deliberate. Entries with no budget remain unbounded; each listed entry states the
 * graph it is allowed to reach.
 */
const BUDGETS = {
	"packages/schema": {
		// The format checks (vendored from TypeBox, about 40 KB) load only through ./formats.
		".": { maxFiles: 10, forbid: ["schema/src/formats/"] },
	},
	"packages/ai": {
		"./models": {
			// Request telemetry reaches pi-ai's telemetry.ts and pi-telemetry's root (index, noop, metrics, memory).
			// Request identity reaches utils/identity.ts and its version constant.
			maxFiles: 20,
			forbid: ["providers/", "models.generated.ts", "index.ts", "utils/validation.ts", "utils/string-enum.ts"],
			allow: ["packages/telemetry/src/index.ts"],
		},
		"./utils/*": {
			maxFiles: 3,
			forbid: ["providers/", "api/", "index.ts"],
			overrides: {
				// Tool argument validation runs on pi-schema: its validator, coercion and format checks (the checks TypeBox's
				// validator ran by default). TypeBox, an external package, was not counted before.
				"./utils/validation": { maxFiles: 42, forbid: ["providers/", "api/", "packages/ai/src/index.ts"] },
			},
		},
	},
	"packages/codemode": {
		// Node and Bun users never load the Cloudflare entry, which imports the `cloudflare:workers` built-in.
		".": { maxFiles: 12, forbid: ["codemode/src/cloudflare.ts"] },
		// Runtimes without Node built-ins (Workers, browsers) import these; neither may reach the worker-thread host
		// or the file-based wasm loader.
		"./portable": {
			maxFiles: 8,
			forbid: ["codemode/src/index.ts", "runtime/host.ts", "runtime/worker.ts", "codemode/src/wasm.ts"],
		},
		"./cloudflare": {
			maxFiles: 9,
			forbid: ["codemode/src/index.ts", "runtime/host.ts", "runtime/worker.ts", "codemode/src/wasm.ts"],
		},
	},
	"packages/durable": {
		".": {
			// Tool argument validation reaches pi-schema (validator, coercion and format checks; 39 files that replace
			// TypeBox, which this walk did not count); provider-session creation reaches pi-ai's lean UUID utility; the
			// memory and SQLite storages share scan order and cursor handling. Values from Chord's root (copyJson,
			// replicatedState) reach its host runtime through the root barrel. Chord's context reaches pi-telemetry's root
			// (index, noop, metrics, memory) for its NOOP telemetry default; harness/telemetry.ts is Durable's schema.
			// The fork's target-model estimates replay signatures through ai/utils/transform-messages.ts.
			// Shared retry backoff reaches the lean ai/utils/sleep.ts and abort.ts helpers, not the AI barrel.
			// The Harness's request identity reaches pi-ai's utils/identity.ts and its version constant. Partial commits
			// parse streamed tool-call arguments with pi-ai's utils/streaming-json.ts (and its json-parse.ts) to append what
			// argument strings grew by (harness/partial-changes.ts). Chord's watches fold pending ops with Delta's
			// pending queue (delta/pending.ts). `registryReader` (harness/registry-reader.ts) reads a Chord v2 registry
			// value through type-only imports. The Session caches hot Storage reads (session/cached-storage.ts) and keeps
			// each conversation's newest entry and head marker (session/conversation-tails.ts). Group commit sends batches
			// through `commit()`, or one `commit()` each (storage/commit-batch.ts), from a writer off the Session line
			// (session/writer.ts) that gates reads by the keys of unpublished writes (session/keys.ts).
			maxFiles: 126,
			forbid: [
				"packages/ai/src/index.ts",
				"packages/ai/src/utils/string-enum.ts",
				// Photon (WebAssembly) loads only through `./images`.
				"packages/durable/src/images/",
			],
		},
		// The file tools reach their environment helpers and the Harness definitions they need, not the Harness itself,
		// and pi-schema's root for their schema builders (10 files; its format checks stay out).
		"./tools": { maxFiles: 27, forbid: ["packages/durable/src/images/", "packages/schema/src/formats/"] },
		"./tools/edit-diff": {
			maxFiles: 1,
			forbid: [
				"packages/durable/src/images/",
				"packages/durable/src/env/",
				"packages/durable/src/harness/",
				"index.ts",
			],
		},
	},
	"packages/coding-agent": {
		// Standalone supervisor and detached background-job processes must stay off TypeBox, settings, and TUI.
		"./src/cli-launcher.ts": {
			maxFiles: 12,
			forbid: [
				"core/settings-manager.ts",
				"core/settings-schema.ts",
				"core/agent-session.ts",
				"modes/",
				"packages/ai/",
				"packages/tui/",
				"packages/schema/",
			],
			forbidExternal: ["typebox"],
		},
		"./src/extensions/background-command/worker.ts": {
			maxFiles: 9,
			forbid: [
				"core/tools/bash.ts",
				"core/settings-manager.ts",
				"modes/",
				"packages/ai/",
				"packages/tui/",
				"packages/schema/",
			],
			forbidExternal: ["typebox"],
		},
	},
};

const SPEC = /(?:^|\n)\s*(?:import|export)\s+(?!type\s)([^;]*?\sfrom\s*)?["']([^"']+)["']/g;

function resolveSpec(spec, fromFile) {
	if (isBuiltin(spec)) return null;
	if (spec.startsWith(".")) {
		const base = resolve(dirname(fromFile), spec);
		for (const candidate of [base, `${base}.ts`, `${base}/index.ts`]) {
			if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
		}
		return null;
	}
	for (const [name, src] of Object.entries(WORKSPACE)) {
		if (spec === name) return resolve(ROOT, src, "index.ts");
		if (!spec.startsWith(`${name}/`)) continue;
		const tail = spec.slice(name.length + 1);
		for (const candidate of [`${tail}.ts`, `${tail}/index.ts`, tail]) {
			const file = resolve(ROOT, src, candidate);
			if (existsSync(file) && statSync(file).isFile()) return file;
		}
	}
	return null; // external dependency: not part of the workspace graph
}

function walk(entryFile) {
	const seen = new Set();
	const externals = new Set();
	const queue = [entryFile];
	while (queue.length > 0) {
		const file = queue.pop();
		if (seen.has(file) || file.endsWith(".json")) continue;
		seen.add(file);
		for (const match of readFileSync(file, "utf8").matchAll(SPEC)) {
			const spec = match[2];
			const target = resolveSpec(spec, file);
			if (target) queue.push(target);
			else if (!spec.startsWith(".") && !isBuiltin(spec)) externals.add(spec);
		}
	}
	return { seen, externals };
}

/** `./dist/harness/context.js` in the exports map is `src/harness/context.ts` on disk. */
function sourceFor(pkgDir, distPath) {
	const rel = distPath.replace(/^\.\/dist\//, "").replace(/\.js$/, ".ts");
	const file = resolve(ROOT, pkgDir, "src", rel);
	return existsSync(file) ? file : undefined;
}

function expand(pkgDir, entry, target) {
	if (!entry.includes("*")) return [[entry, target]];
	const dir = resolve(ROOT, pkgDir, "src", dirname(target.replace(/^\.\/dist\//, "")));
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith(".ts"))
		.map((name) => [entry.replace("*", name.replace(/\.ts$/, "")), target.replace("*", name.replace(/\.ts$/, ""))]);
}

let failures = 0;
for (const [pkgDir, budgets] of Object.entries(BUDGETS)) {
	const manifest = JSON.parse(readFileSync(resolve(ROOT, pkgDir, "package.json"), "utf8"));
	for (const [entry, budget] of Object.entries(budgets)) {
		const isInternalSource = entry.startsWith("./src/");
		const declared = isInternalSource ? entry : manifest.exports?.[entry];
		if (!declared) {
			console.error(`${pkgDir} declares no export "${entry}" but a budget exists for it`);
			failures += 1;
			continue;
		}
		const target = typeof declared === "string" ? declared : declared.import;
		const entries = isInternalSource ? [[entry, target]] : expand(pkgDir, entry, target);
		for (const [name, distPath] of entries) {
			// A wildcard entry's budget applies to every file it exports, unless `overrides` names that file.
			const limits = budget.overrides?.[name] ?? budget;
			const source = isInternalSource ? resolve(ROOT, pkgDir, distPath) : sourceFor(pkgDir, distPath);
			if (!source || !existsSync(source)) {
				console.error(`${pkgDir} export "${name}" points at ${distPath}, which has no source file`);
				failures += 1;
				continue;
			}
			const { seen, externals } = walk(source);
			const graph = [...seen].map((file) => relative(ROOT, file).split(sep).join("/"));
			if (graph.length > limits.maxFiles) {
				console.error(
					`${pkgDir} export "${name}" reaches ${graph.length} files, budget ${limits.maxFiles}\n` +
						graph.map((file) => `    ${file}`).join("\n"),
				);
				failures += 1;
			}
			for (const pattern of limits.forbid ?? []) {
				const hit = graph.filter((file) => file.includes(pattern) && !(limits.allow ?? []).some((allowed) => file.endsWith(allowed)));
				if (hit.length > 0) {
					console.error(`${pkgDir} export "${name}" must not reach ${pattern}:\n${hit.map((f) => `    ${f}`).join("\n")}`);
					failures += 1;
				}
			}
			for (const pkg of limits.forbidExternal ?? []) {
				const hit = [...externals].filter((spec) => spec === pkg || spec.startsWith(`${pkg}/`));
				if (hit.length > 0) {
					console.error(`${pkgDir} entry "${name}" must not import ${pkg}: ${hit.join(", ")}`);
					failures += 1;
				}
			}
		}
	}
}

if (failures > 0) {
	console.error(`\n${failures} entry-point budget violation(s).`);
	process.exit(1);
}
console.log("Entry point graphs are within budget.");
