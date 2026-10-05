import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const cli = process.env.PI_TEST_COMPILED_CLI ?? "";
if (process.env.PI_TEST_COMPILED_CLI !== undefined && !existsSync(cli)) {
	throw new Error(`PI_TEST_COMPILED_CLI must select an existing standalone CLI: ${cli}`);
}

describe.skipIf(process.env.PI_TEST_COMPILED_CLI === undefined)("compiled extension packages", () => {
	// pi-cursor-sdk #228: factory loading succeeds but request-time public package resolution fails.
	it("loads public package entrypoints on request without enabling project preloads", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-compiled-packages-"));
		try {
			const home = join(root, "home");
			const cwd = join(root, "work");
			const extension = join(root, "extension.ts");
			const receipt = join(root, "receipt.jsonl");
			const dependency = join(root, "node_modules", "@compiled", "exports");
			const transitive = join(dependency, "node_modules", "@compiled", "transitive");
			const mainOnly = join(root, "node_modules", "@compiled", "main");
			for (const path of [home, cwd, dependency, transitive, mainOnly, join(cwd, ".pi", "extensions")]) {
				mkdirSync(path, { recursive: true });
			}
			const record = `import { appendFileSync } from 'node:fs';
const record = (event) => appendFileSync(${JSON.stringify(receipt)}, JSON.stringify(event) + '\\n');`;
			writeFileSync(
				join(dependency, "package.json"),
				JSON.stringify({
					name: "@compiled/exports",
					type: "module",
					exports: { ".": { bun: "./bun.mjs", import: "./wrong.mjs", require: "./wrong.mjs" } },
				}),
			);
			writeFileSync(
				join(dependency, "bun.mjs"),
				`import { value } from '@compiled/transitive';
${record}
record({ phase: 'package' });
export const result = 'bun:' + value;`,
			);
			writeFileSync(join(dependency, "wrong.mjs"), "throw new Error('Wrong export condition');");
			writeFileSync(join(dependency, "private.mjs"), "export const value = 'private';");
			writeFileSync(
				join(transitive, "package.json"),
				JSON.stringify({ name: "@compiled/transitive", type: "module", exports: { ".": "./value.mjs" } }),
			);
			writeFileSync(
				join(transitive, "value.mjs"),
				`${record}\nrecord({ phase: 'transitive' });\nexport const value = 'transitive';`,
			);
			writeFileSync(join(mainOnly, "package.json"), JSON.stringify({ name: "@compiled/main", main: "./entry.cjs" }));
			writeFileSync(join(mainOnly, "entry.cjs"), "module.exports = { value: 'main-only' };");
			writeFileSync(join(cwd, "preload.mjs"), "throw new Error('Project preload executed');");
			writeFileSync(join(cwd, "bunfig.toml"), 'preload = ["./preload.mjs"]\n');
			writeFileSync(join(cwd, ".pi", "extensions", "denied.js"), `${record}\nrecord({ phase: 'untrusted' });`);
			writeFileSync(
				extension,
				`import { createRequire } from 'node:module';
import { fauxProvider } from '@earendil-works/pi-ai';
${record}
const require = createRequire(import.meta.url);
export default function(pi) {
 const faux = fauxProvider();
 pi.registerProvider('faux', { api: faux.api, baseUrl: faux.getModel().baseUrl, apiKey: 'faux-key', models: faux.models, streamSimple: faux.provider.streamSimple });
 pi.registerCommand('compiled-packages', {
  description: 'Load public packages on request',
  handler: async () => {
   const { result } = require('@compiled/exports');
   const { value: main } = require('@compiled/main');
   let privateDenied = false;
   try { require('@compiled/exports/private.mjs'); } catch { privateDenied = true; }
   record({ phase: 'request', result, main, privateDenied, bun: !!process.versions.bun, calls: faux.state.callCount });
  }
 });
 record({ phase: 'factory' });
}`,
			);
			const result = spawnSync(
				cli,
				[
					"--offline",
					"--no-approve",
					"--no-session",
					"--no-skills",
					"--no-prompt-templates",
					"--no-context-files",
					"--no-themes",
					"--model",
					"faux/faux-1",
					"-e",
					extension,
					"-p",
					"/compiled-packages",
				],
				{
					cwd,
					env: {
						PATH: dirname(process.execPath),
						HOME: home,
						USERPROFILE: home,
						PI_CODING_AGENT_DIR: join(home, "agent"),
						PI_TELEMETRY: "0",
						JITI_FS_CACHE: "0",
						...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
					},
					encoding: "utf8",
					timeout: 30_000,
				},
			);
			expect(result.error, result.stderr).toBeUndefined();
			expect(result.status, result.stderr).toBe(0);
			const events = existsSync(receipt)
				? readFileSync(receipt, "utf8")
						.trim()
						.split("\n")
						.map((line) => JSON.parse(line) as unknown)
				: [];
			expect(events, `${result.stdout}\n${result.stderr}`).toEqual([
				{ phase: "factory" },
				{ phase: "transitive" },
				{ phase: "package" },
				{ phase: "request", result: "bun:transitive", main: "main-only", privateDenied: true, bun: true, calls: 0 },
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
