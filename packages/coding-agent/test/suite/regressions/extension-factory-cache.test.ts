import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearExtensionCache, loadExtensions, loadExtensionsCached } from "../../../src/core/extensions/loader.ts";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";

interface TestState {
	moduleLoads?: number;
	factoryRuns?: number;
}

function state(): TestState {
	const global = globalThis as typeof globalThis & { __extensionFactoryCacheTest?: TestState };
	if (!global.__extensionFactoryCacheTest) {
		global.__extensionFactoryCacheTest = {};
	}
	return global.__extensionFactoryCacheTest;
}

function resetState(): void {
	delete (globalThis as typeof globalThis & { __extensionFactoryCacheTest?: TestState }).__extensionFactoryCacheTest;
}

function writeCountingExtension(filePath: string): void {
	writeFileSync(
		filePath,
		`
const state = (globalThis.__extensionFactoryCacheTest ??= {});
state.moduleLoads = (state.moduleLoads ?? 0) + 1;

export default function () {
	state.factoryRuns = (state.factoryRuns ?? 0) + 1;
}
`,
		"utf-8",
	);
}

describe("extension factory cache", () => {
	const roots: string[] = [];

	function fixture(name: string) {
		const root = join(tmpdir(), `pi-extension-cache-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		roots.push(root);
		return { root, cwd, agentDir };
	}

	beforeEach(() => {
		resetState();
		clearExtensionCache();
	});

	afterEach(() => {
		while (roots.length > 0) {
			const root = roots.pop();
			if (root && existsSync(root)) {
				rmSync(root, { recursive: true, force: true });
			}
		}
		resetState();
		clearExtensionCache();
	});

	it("caches extension modules for cached same-cwd loads but reruns factories", async () => {
		const { root, cwd } = fixture("same-cwd");
		const extensionPath = join(root, "counting.ts");
		writeCountingExtension(extensionPath);

		const first = await loadExtensionsCached([extensionPath], cwd);
		const second = await loadExtensionsCached([extensionPath], cwd);

		expect(state().moduleLoads).toBe(1);
		expect(state().factoryRuns).toBe(2);
		expect(first.extensions[0]).not.toBe(second.extensions[0]);
		expect(first.runtime).not.toBe(second.runtime);
	});

	it("does not cache direct loadExtensions calls", async () => {
		const { root, cwd } = fixture("direct");
		const extensionPath = join(root, "counting.ts");
		writeCountingExtension(extensionPath);

		await loadExtensions([extensionPath], cwd);
		await loadExtensions([extensionPath], cwd);

		expect(state().moduleLoads).toBe(2);
		expect(state().factoryRuns).toBe(2);
	});

	it("reuses cached modules but reruns factories on resource loader reload", async () => {
		const { cwd, agentDir } = fixture("reload");
		const extensionDir = join(agentDir, "extensions");
		mkdirSync(extensionDir, { recursive: true });
		writeCountingExtension(join(extensionDir, "counting.ts"));
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
		});

		await loader.reload();
		await loader.reload();

		expect(state().moduleLoads).toBe(1);
		expect(state().factoryRuns).toBe(2);
	});

	it.each(["js", "ts"])("requires a process restart for changed %s entrypoints and schemas", async (ext) => {
		const { root, cwd, agentDir } = fixture(`update-${ext}`);
		const extensionDir = join(agentDir, "extensions", "package");
		mkdirSync(extensionDir, { recursive: true });
		const promptsDir = join(agentDir, "prompts");
		mkdirSync(promptsDir);
		const writeVersion = (version: number) => {
			writeFileSync(
				join(extensionDir, "package.json"),
				JSON.stringify({ type: "module", version: `0.${version}.0` }),
			);
			writeFileSync(join(promptsDir, "prompt.md"), `prompt version ${version}`);
			writeFileSync(
				join(extensionDir, `index.${ext}`),
				`import { parameters } from "./schema.${ext}";
export default function (pi) {
	pi.registerTool({
		name: "reload_probe",
		label: "Reload probe",
		description: "version ${version}",
		parameters,
		async execute() { return { content: [{ type: "text", text: "version ${version}" }] }; },
	});
}`,
			);
			writeFileSync(
				join(extensionDir, `schema.${ext}`),
				`export const parameters = { type: "object", properties: { action: { type: "string", enum: ["version_${version}"] } } };`,
			);
		};
		const options = { cwd, agentDir, noSkills: true, noThemes: true };
		const loader = new DefaultResourceLoader(options);

		for (const version of [1, 2]) {
			writeVersion(version);
			await loader.reload();
			expect(loader.getExtensions().errors).toEqual([]);
			expect(loader.getExtensions().extensions[0].tools.get("reload_probe")?.definition).toMatchObject({
				description: "version 1",
				parameters: { properties: { action: { enum: ["version_1"] } } },
			});
			expect(loader.getPrompts().prompts[0].content).toBe(`prompt version ${version}`);
		}

		const replacementLoader = new DefaultResourceLoader(options);
		await replacementLoader.reload();
		expect(replacementLoader.getExtensions().extensions[0].tools.get("reload_probe")?.definition).toMatchObject({
			description: "version 1",
			parameters: { properties: { action: { enum: ["version_1"] } } },
		});

		const probePath = join(root, "fresh.mjs");
		writeFileSync(
			probePath,
			`import { DefaultResourceLoader } from ${JSON.stringify(new URL("../../../src/core/resource-loader.ts", import.meta.url).href)};
const loader = new DefaultResourceLoader(${JSON.stringify(options)});
await loader.reload();
if (loader.getExtensions().errors.length) throw new Error(JSON.stringify(loader.getExtensions().errors));
console.log(JSON.stringify(loader.getExtensions().extensions[0].tools.get("reload_probe").definition));`,
		);
		const fresh = execFileSync(
			process.execPath,
			[
				"--import",
				fileURLToPath(new URL("../../../src/experimental/source-resolver.ts", import.meta.url)),
				probePath,
			],
			{
				cwd,
				env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
				encoding: "utf8",
				timeout: 30_000,
			},
		);
		expect(JSON.parse(fresh)).toMatchObject({
			description: "version 2",
			parameters: { properties: { action: { enum: ["version_2"] } } },
		});
	});

	it("keeps the cache scoped to one cwd", async () => {
		const { root } = fixture("cross-cwd");
		const firstCwd = join(root, "first");
		const secondCwd = join(root, "second");
		mkdirSync(firstCwd, { recursive: true });
		mkdirSync(secondCwd, { recursive: true });
		const extensionPath = join(root, "counting.ts");
		writeCountingExtension(extensionPath);

		await loadExtensionsCached([extensionPath], firstCwd);
		await loadExtensionsCached([extensionPath], secondCwd);
		await loadExtensionsCached([extensionPath], secondCwd);

		expect(state().moduleLoads).toBe(2);
		expect(state().factoryRuns).toBe(3);
	});
});
