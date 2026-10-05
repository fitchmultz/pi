import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));

test("workspace root and subpath imports compile through a case-aliased checkout", async (t) => {
	const temporary = await mkdtemp(join(tmpdir(), "pi-workspace-build-"));
	t.after(() => rm(temporary, { recursive: true, force: true }));
	const root = join(realpathSync.native(temporary), "mixed");
	const alias = join(realpathSync.native(temporary), "MiXeD");
	await mkdir(root);
	if (!existsSync(alias)) {
		t.skip("requires a case-insensitive filesystem");
		return;
	}
	const config = JSON.parse(await readFile(join(repo, "packages/durable/tsconfig.build.json"), "utf8"));
	// The fixture exercises workspace resolution, without unrelated ambient Node types.
	config.compilerOptions.types = [];
	const files = {
		"tsconfig.base.json": await readFile(join(repo, "tsconfig.base.json"), "utf8"),
		"packages/durable/tsconfig.build.json": JSON.stringify(config),
		"packages/durable/package.json": JSON.stringify({ type: "module" }),
		"packages/durable/src/index.ts": `
import type { Delta } from "@earendil-works/chord";
import type { Delta as SubpathDelta } from "@earendil-works/chord/delta";
export const identity = (delta: Delta): SubpathDelta => delta;
`,
		"packages/chord/package.json": JSON.stringify({
			name: "@earendil-works/chord",
			version: "1.0.0",
			type: "module",
			exports: { ".": "./dist/index.d.ts", "./delta": "./dist/delta/index.d.ts" },
		}),
		"packages/chord/dist/index.d.ts": 'export type { Delta } from "./delta/index.js";\n',
		"packages/chord/dist/delta/index.d.ts": "export interface Delta { value: string; }\n",
	};
	for (const [path, content] of Object.entries(files)) {
		const fullPath = join(root, path);
		await mkdir(join(fullPath, ".."), { recursive: true });
		await writeFile(fullPath, content);
	}
	await mkdir(join(root, "node_modules/@earendil-works"), { recursive: true });
	await symlink("../../packages/chord", join(root, "node_modules/@earendil-works/chord"));
	const result = spawnSync(process.execPath, [
		join(repo, "node_modules/typescript/bin/tsc"),
		"--noEmit",
		"--project",
		join(alias, "packages/durable/tsconfig.build.json"),
	], { cwd: root, encoding: "utf8" });
	assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});
