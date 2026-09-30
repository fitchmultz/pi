import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const loader = new URL("../packages/coding-agent/dist/core/extensions/loader.js", import.meta.url).href;

for (const type of ["commonjs", "module"]) {
	test(`cold native extension loading and reload with ${type} resolution`, (t) => {
		const root = mkdtempSync(join(tmpdir(), "pi-loader-cold-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const extension = join(root, "extension.ts");
		writeFileSync(join(root, "package.json"), JSON.stringify({ type }));
		mkdirSync(join(root, "cache"));
		writeFileSync(
			extension,
			`import { createRequire } from "node:module";
import { Type } from "typebox";
const path = createRequire(import.meta.url)("node:path");
export default function (pi) {
	pi.registerTool({ name: "cold", label: "cold", description: "cold", parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: path.basename("/cold/loaded") }], details: {} }) });
}`,
		);
		const probe = join(root, "probe.mjs");
		writeFileSync(
			probe,
			`import assert from "node:assert/strict";
import { loadExtensions } from ${JSON.stringify(loader)};
for (let version = 0; version < 2; version++) {
	const result = await loadExtensions([${JSON.stringify(extension)}], process.cwd());
	assert.deepEqual(result.errors, []);
	const tool = result.extensions[0].tools.get("cold").definition;
	assert.deepEqual(await tool.execute("cold", {}, undefined, undefined, {}), {
		content: [{ type: "text", text: "loaded" }], details: {}
	});
}
console.log("cold-load-and-reload:ok");`,
		);
		const output = execFileSync(process.execPath, [probe], {
			cwd: root,
			env: {
				PATH: process.env.PATH,
				HOME: root,
				TMPDIR: root,
				PI_CODING_AGENT_DIR: root,
				PI_OFFLINE: "1",
				JITI_FS_CACHE: join(root, "cache"),
			},
			encoding: "utf8",
			timeout: 30_000,
		});
		assert.equal(output.trim(), "cold-load-and-reload:ok");
	});
}
