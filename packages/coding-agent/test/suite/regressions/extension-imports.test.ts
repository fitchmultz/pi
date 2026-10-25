import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fauxAssistantMessage, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { transformSync } from "esbuild";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEventBus } from "../../../src/core/event-bus.ts";
import { clearExtensionCache, loadExtensions } from "../../../src/core/extensions/loader.ts";
import { createTestResourceLoader } from "../../utilities.ts";
import { createHarness, getAssistantTexts } from "../harness.ts";

interface ImportState {
	activeImports: number;
	maxImports: number;
	activeFactories: number;
	maxFactories: number;
	moduleLoads: number;
	factories: string[];
	events: string[];
}

const globals = globalThis as typeof globalThis & { __issue250?: ImportState };

describe("extension imports (fitchmultz/pi#250)", () => {
	let root: string;
	let state: ImportState;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-extension-imports-"));
		state = {
			activeImports: 0,
			maxImports: 0,
			activeFactories: 0,
			maxFactories: 0,
			moduleLoads: 0,
			factories: [],
			events: [],
		};
		globals.__issue250 = state;
		clearExtensionCache();
	});

	afterEach(() => {
		clearExtensionCache();
		delete globals.__issue250;
		rmSync(root, { recursive: true, force: true });
	});

	function moduleFile(name: string, source: string, compiled = false): string {
		const file = join(root, name);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(
			file,
			compiled ? transformSync(source, { loader: "ts", format: "esm", target: "es2022" }).code : source,
		);
		return file;
	}

	// fitchmultz/pi#250: real imports must preserve the provider's ordered registrations and prompt bytes.
	it.each(["delayed TypeScript", "compiled ESM"])(
		"loads %s modules before sequential factories and a real prompt",
		async (shape) => {
			const compiled = shape === "compiled ESM";
			const suffix = compiled ? "js" : "ts";
			if (compiled) {
				moduleFile("package.json", JSON.stringify({ type: "module" }));
				moduleFile("shared/leaf.js", 'export const label: string = "Synthetic";', true);
				moduleFile(
					"shared/description.js",
					'import { label } from "./leaf.js"; export const description: string = label + " tool";',
					true,
				);
			} else {
				moduleFile("shared.ts", 'export const description: string = "Synthetic tool";');
			}
			const names = ["alpha", "beta", "gamma"];
			const paths = names.map((name, index) => {
				if (compiled)
					moduleFile(`${name}/metadata.js`, 'export { description } from "../shared/description.js";', true);
				return moduleFile(
					compiled ? `${name}/index.js` : `${name}.ts`,
					`${compiled ? 'const parameters = { type: "object", properties: {} };' : 'import { Type } from "@sinclair/typebox"; const parameters = Type.Object({});'}
import { description } from "${compiled ? "./metadata.js" : `./shared.${suffix}`}";
const state = globalThis.__issue250;
state.moduleLoads++;
state.maxImports = Math.max(state.maxImports, ++state.activeImports);
${compiled ? "" : `await new Promise(resolve => setTimeout(resolve, ${[60, 5, 20][index]}));`}
state.activeImports--;
export default async function(pi) {
	state.maxFactories = Math.max(state.maxFactories, ++state.activeFactories);
	state.factories.push("start:${name}");
	await new Promise(resolve => setTimeout(resolve, 5));
	pi.registerTool({ name: "${name}", label: "${name}", description,
		parameters, execute: async () => ({ content: [{ type: "text", text: "ok" }] }) });
	pi.registerCommand("${name}", { handler: async () => {} });
	pi.registerFlag("${name}-flag", { type: "string", default: "${name}" });
	pi.on("before_agent_start", event => ({ systemPrompt: ${index === 0 ? '"prompt:alpha"' : `event.systemPrompt + "|${name}"`} }));
	pi.events.on("ordered", () => state.events.push("${name}"));
	state.factories.push("end:${name}");
	state.activeFactories--;
}`,
					compiled,
				);
			});
			const eventBus = createEventBus();
			const result = await loadExtensions(paths, root, eventBus);
			expect(result.errors).toEqual([]);
			expect(state.moduleLoads).toBe(3);
			expect(state.maxImports).toBe(compiled ? 1 : 3);
			expect(state.activeImports).toBe(0);
			expect(state.maxFactories).toBe(1);
			expect(state.factories).toEqual(names.flatMap((name) => [`start:${name}`, `end:${name}`]));
			expect([...result.runtime.flagValues]).toEqual(names.map((name) => [`${name}-flag`, name]));
			expect(
				result.extensions.map((extension, index) => extension.tools.get(names[index])?.definition.description),
			).toEqual(names.map(() => "Synthetic tool"));
			eventBus.emit("ordered", undefined);
			expect(state.events).toEqual(names);

			const harness = await createHarness({
				resourceLoader: createTestResourceLoader({ extensionsResult: result }),
			});
			try {
				await harness.session.bindExtensions({});
				const requests: Array<{ systemPrompt: string; tools: string[] }> = [];
				harness.setResponses([
					(context) => {
						requests.push({
							systemPrompt: getCurrentSystemPrompt(context.messages),
							tools: getCurrentTools(context.messages).map((tool) => tool.name),
						});
						return fauxAssistantMessage("ready");
					},
				]);
				await harness.session.prompt("hello");
				expect(requests).toEqual([
					{ systemPrompt: "prompt:alpha|beta|gamma", tools: ["read", "bash", "edit", "write", ...names] },
				]);
				expect(getAssistantTexts(harness)).toEqual(["ready"]);
			} finally {
				harness.cleanup();
			}
		},
	);

	// fitchmultz/pi#250: returned errors follow discovery, not rejection completion order.
	it("reports a slow import failure before a later fast failure", async () => {
		const paths = [
			moduleFile("slow.ts", 'await new Promise(r => setTimeout(r, 30)); throw new Error("slow import");'),
			moduleFile("fast.ts", 'throw new Error("fast import");'),
			moduleFile("invalid.js", "export const notAFactory = true;"),
			moduleFile("factory.ts", 'export default () => { throw new Error("factory failure"); };'),
			moduleFile("good.cjs", 'module.exports = pi => pi.registerCommand("good", { handler: async () => {} });'),
		];
		const result = await loadExtensions(paths, root);
		expect(result.errors).toEqual([
			{ path: paths[0], error: "Failed to load extension: slow import" },
			{ path: paths[1], error: "Failed to load extension: fast import" },
			{ path: paths[2], error: `Extension does not export a valid factory function: ${paths[2]}` },
			{ path: paths[3], error: "Failed to load extension: factory failure" },
		]);
		expect(result.extensions.map((extension) => extension.path)).toEqual([paths[4]]);
		expect([...result.extensions[0].commands.keys()]).toEqual(["good"]);
	});
});
