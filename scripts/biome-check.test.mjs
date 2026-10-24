import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const script = join(root, "scripts/biome-check.mjs");
const configuration = await readFile(join(root, "biome.json"), "utf8");
const mockedSuite = "packages/ai/test/openai-completions-tool-choice.test.ts";
const hasNativeBinary = ["win32", "darwin", "linux"].includes(process.platform) && ["x64", "arm64"].includes(process.arch);

// 0f7daf39e repaired two mocked tests after this catalog model was delisted.
const discardedCompat = `export function withAssertion() {
	const { compat: _compat, ...baseModel } = getModel("opencode-go", "kimi-k2.6")!;
	return baseModel;
}

export function withoutAssertion() {
	const { compat: _discarded, ...baseModel } = getModel("opencode-go", "kimi-k2.6");
	return baseModel;
}
`;

const cases = [
	{
		name: "rejects discarded catalog compat with and without a non-null assertion",
		path: mockedSuite,
		content: discardedCompat,
		message: /stable typed fixture based on localOpenAICompletionsModel/g,
		errors: 2,
	},
	{
		name: "keeps ordinary catalog calls, retained compat, and typed payload fixtures",
		path: mockedSuite,
		content: `export const catalogModel = getModel("openai", "gpt-4o-mini")!;
export const payloadModel = { ...localOpenAICompletionsModel, id: "fixture", name: "Fixture" };

export function withCompat() {
	const { compat: compatibility, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
	return { compatibility, baseModel };
}
`,
	},
	{
		name: "leaves live catalog fixtures outside the mocked suite unchanged",
		path: "packages/ai/test/tokens.test.ts",
		content: discardedCompat,
	},
	{
		name: "preserves the existing root plugin inside the overridden suite",
		path: mockedSuite,
		content: 'export const chat = model.type === "chat";\n',
		message: /Chat models may omit type/g,
		errors: 1,
	},
];

for (const engine of ["native", "wasm"]) {
	test(`Biome ${engine} enforces scoped payload fixtures`, { skip: engine === "native" && !hasNativeBinary }, async (t) => {
		for (const fixture of cases) {
			await t.test(fixture.name, async (t) => {
				const directory = await mkdtemp(join(tmpdir(), "pi-biome-check-"));
				t.after(() => rm(directory, { recursive: true, force: true }));
				await writeFile(join(directory, "biome.json"), configuration);
				await cp(join(root, "scripts/biome"), join(directory, "scripts/biome"), { recursive: true });
				const path = join(directory, fixture.path);
				await mkdir(dirname(path), { recursive: true });
				await writeFile(path, fixture.content);
				const git = spawnSync("git", ["init", "--quiet"], { cwd: directory, encoding: "utf8" });
				assert.equal(git.status, 0, git.stderr);

				const args = [];
				if (engine === "wasm") {
					const preload = join(directory, "android.mjs");
					await writeFile(preload, 'Object.defineProperty(process, "platform", { value: "android" });\n');
					args.push("--import", pathToFileURL(preload).href);
				}
				const result = spawnSync(process.execPath, [...args, script], { cwd: directory, encoding: "utf8" });
				const output = result.stdout + result.stderr;
				assert.equal(result.status, fixture.errors ? 1 : 0, output);
				if (fixture.message) assert.equal([...output.matchAll(fixture.message)].length, fixture.errors, output);
			});
		}
	});
}
