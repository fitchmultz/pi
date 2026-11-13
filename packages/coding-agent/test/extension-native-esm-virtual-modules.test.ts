import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as hostPiAi from "@earendil-works/pi-ai/compat";
import * as hostPiTui from "@earendil-works/pi-tui";
import * as hostTypebox from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { clearExtensionCache, loadExtensions } from "../src/core/extensions/loader.ts";
import * as hostPiCodingAgent from "../src/index.ts";

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	clearExtensionCache();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("extension native ESM and CJS host module fallback", () => {
	it("resolves host packages in compiled type=module .js, dynamic .mjs imports, and .cjs helpers without node_modules", async () => {
		const root = createTempDir("pi-ext-native-esm-");
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "compiled-ext-pkg", type: "module" }));

		writeFileSync(
			join(root, "dynamic-helper.mjs"),
			[
				'import { formatDimensionNote } from "@earendil-works/pi-coding-agent";',
				'import { resizeImage } from "@mariozechner/pi-coding-agent";',
				'import { Type } from "typebox";',
				"export const mjsRefs = { formatDimensionNote, resizeImage, Type };",
			].join("\n"),
		);

		writeFileSync(
			join(root, "helper.cjs"),
			[
				'const { formatDimensionNote } = require("@earendil-works/pi-coding-agent");',
				"module.exports = { formatDimensionNote };",
			].join("\n"),
		);

		const extensionPath = join(root, "index.js");
		writeFileSync(
			extensionPath,
			[
				'import { truncateToWidth } from "@earendil-works/pi-tui";',
				'import { registerFauxProvider } from "@earendil-works/pi-ai";',
				'import cjsRefs from "./helper.cjs";',
				"",
				"export default async function (pi) {",
				'\tconst { mjsRefs } = await import("./dynamic-helper.mjs");',
				"\tglobalThis.__piNativeEsmProbe = { truncateToWidth, registerFauxProvider, mjsRefs, cjsRefs };",
				'\tpi.registerCommand("probe", { description: "probe", handler: async () => {} });',
				"}",
			].join("\n"),
		);

		delete (globalThis as Record<string, unknown>).__piNativeEsmProbe;
		const result = await loadExtensions([extensionPath], root);
		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);

		const probe = (globalThis as Record<string, unknown>).__piNativeEsmProbe as {
			truncateToWidth: unknown;
			registerFauxProvider: unknown;
			mjsRefs: { formatDimensionNote: unknown; resizeImage: unknown; Type: unknown };
			cjsRefs: { formatDimensionNote: unknown };
		};
		expect(probe.truncateToWidth).toBe(hostPiTui.truncateToWidth);
		expect(probe.registerFauxProvider).toBe(hostPiAi.registerFauxProvider);
		expect(probe.mjsRefs.formatDimensionNote).toBe(hostPiCodingAgent.formatDimensionNote);
		expect(probe.mjsRefs.resizeImage).toBe(hostPiCodingAgent.resizeImage);
		expect(probe.mjsRefs.Type).toBe(hostTypebox.Type);
		expect(probe.cjsRefs.formatDimensionNote).toBe(hostPiCodingAgent.formatDimensionNote);
	});

	it("persists jiti transpile cache entries under XDG_CACHE_HOME/pi/jiti", async () => {
		const root = createTempDir("pi-ext-jiti-cache-");
		const xdgCache = join(root, "xdg-cache");
		const prevXdgCache = process.env.XDG_CACHE_HOME;
		process.env.XDG_CACHE_HOME = xdgCache;
		try {
			clearExtensionCache();
			const extensionPath = join(root, "cached-ext.ts");
			writeFileSync(
				extensionPath,
				'export default function (pi: { registerCommand: (n: string, o: unknown) => void }): void { pi.registerCommand("cached", { description: "c", handler: async () => {} }); }\n',
			);

			const result = await loadExtensions([extensionPath], root);
			expect(result.errors).toEqual([]);

			const jitiCacheDir = join(xdgCache, "pi", "jiti");
			expect(existsSync(jitiCacheDir)).toBe(true);
			expect(readdirSync(jitiCacheDir).length).toBeGreaterThan(0);
		} finally {
			if (prevXdgCache === undefined) delete process.env.XDG_CACHE_HOME;
			else process.env.XDG_CACHE_HOME = prevXdgCache;
		}
	});
});
