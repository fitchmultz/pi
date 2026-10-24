import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEventBus } from "../../../src/core/event-bus.ts";
import { clearExtensionCache, loadExtensions, loadExtensionsCached } from "../../../src/core/extensions/loader.ts";
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

describe("extension imports (#250)", () => {
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

	function moduleFile(name: string, source: string): string {
		const file = join(root, name);
		writeFileSync(file, source);
		return file;
	}

	// #250: real jiti evaluation must overlap, but the provider must see ordered registrations and prompt bytes.
	it("overlaps delayed imports and serializes asynchronous factories through a real prompt", async () => {
		moduleFile("shared.ts", 'export const description: string = "Synthetic tool";');
		const names = ["alpha", "beta", "gamma"];
		const paths = names.map((name, index) =>
			moduleFile(
				`${name}.ts`,
				`import { Type } from "@sinclair/typebox";
import { description } from "./shared.ts";
const state = globalThis.__issue250;
state.moduleLoads++;
state.maxImports = Math.max(state.maxImports, ++state.activeImports);
await new Promise(resolve => setTimeout(resolve, ${[60, 5, 20][index]}));
state.activeImports--;
export default async function(pi) {
	state.maxFactories = Math.max(state.maxFactories, ++state.activeFactories);
	state.factories.push("start:${name}");
	await new Promise(resolve => setTimeout(resolve, 5));
	pi.registerTool({ name: "${name}", label: "${name}", description,
		parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "ok" }] }) });
	pi.registerCommand("${name}", { handler: async () => {} });
	pi.registerFlag("${name}-flag", { type: "string", default: "${name}" });
	pi.on("before_agent_start", event => ({ systemPrompt: ${index === 0 ? '"prompt:alpha"' : `event.systemPrompt + "|${name}"`} }));
	pi.events.on("ordered", () => state.events.push("${name}"));
	state.factories.push("end:${name}");
	state.activeFactories--;
}`,
			),
		);
		const eventBus = createEventBus();
		const result = await loadExtensions(paths, root, eventBus);
		expect(result.errors).toEqual([]);
		expect(state.moduleLoads).toBe(3);
		expect(state.maxImports).toBe(3);
		expect(state.activeImports).toBe(0);
		expect(state.maxFactories).toBe(1);
		expect(state.factories).toEqual(names.flatMap((name) => [`start:${name}`, `end:${name}`]));
		expect([...result.runtime.flagValues]).toEqual(names.map((name) => [`${name}-flag`, name]));
		eventBus.emit("ordered", undefined);
		expect(state.events).toEqual(names);

		const harness = await createHarness({ resourceLoader: createTestResourceLoader({ extensionsResult: result }) });
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
	});

	it("reports import and factory failures in discovery order and discards failed subscriptions", async () => {
		const paths = [
			moduleFile("slow.ts", 'await new Promise(r => setTimeout(r, 30)); throw new Error("slow import");'),
			moduleFile("fast.ts", 'throw new Error("fast import");'),
			moduleFile("invalid.js", "export const notAFactory = true;"),
			moduleFile(
				"factory.ts",
				`export default pi => {
	pi.events.on("ordered", () => globalThis.__issue250.events.push("failed"));
	pi.registerFlag("failed", { type: "boolean", default: true });
	throw new Error("factory failure");
}`,
			),
			moduleFile("good.cjs", 'module.exports = pi => pi.registerCommand("good", { handler: async () => {} });'),
		];
		const eventBus = createEventBus();
		const result = await loadExtensions(paths, root, eventBus);
		expect(result.errors).toEqual([
			{ path: paths[0], error: "Failed to load extension: slow import" },
			{ path: paths[1], error: "Failed to load extension: fast import" },
			{ path: paths[2], error: `Extension does not export a valid factory function: ${paths[2]}` },
			{ path: paths[3], error: "Failed to load extension: factory failure" },
		]);
		expect(result.extensions.map((extension) => extension.path)).toEqual([paths[4]]);
		expect([...result.extensions[0].commands.keys()]).toEqual(["good"]);
		expect(result.runtime.flagValues.has("failed")).toBe(false);
		eventBus.emit("ordered", undefined);
		expect(state.events).toEqual([]);
	});

	it("keeps cached factories fresh per runtime and clears prefetched modules on invalidation", async () => {
		const paths = ["one", "two"].map((name) =>
			moduleFile(
				`${name}.ts`,
				`globalThis.__issue250.moduleLoads++;
await new Promise(r => setTimeout(r, 10));
export default pi => pi.registerCommand("${name}", { handler: async () => {} });`,
			),
		);
		const first = await loadExtensionsCached(paths, root);
		const second = await loadExtensionsCached(paths, root);
		expect(state.moduleLoads).toBe(2);
		expect(second.extensions[0]).not.toBe(first.extensions[0]);
		expect(second.runtime).not.toBe(first.runtime);
		clearExtensionCache();
		const inFlight = loadExtensionsCached(paths, root);
		clearExtensionCache();
		await inFlight;
		await loadExtensionsCached(paths, root);
		expect(state.moduleLoads).toBe(6);
	});
});
