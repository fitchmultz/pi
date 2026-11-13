import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

describe("extension native ESM and CJS host module resolution", () => {
	it("resolves host packages inside .mjs, type=module .js, and .cjs helpers without extension node_modules", async () => {
		const root = createTempDir("pi-ext-native-esm-");
		const esmSubpkg = join(root, "subpkg");
		mkdirSync(esmSubpkg, { recursive: true });

		writeFileSync(join(esmSubpkg, "package.json"), JSON.stringify({ name: "ext-subpkg", type: "module" }));
		writeFileSync(
			join(esmSubpkg, "index.js"),
			[
				'import { truncateToWidth } from "@earendil-works/pi-tui";',
				'import { registerFauxProvider } from "@earendil-works/pi-ai";',
				"export const esmJsRefs = { truncateToWidth, registerFauxProvider };",
			].join("\n"),
		);

		writeFileSync(
			join(root, "helper.mjs"),
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

		const extensionPath = join(root, "ext.ts");
		writeFileSync(
			extensionPath,
			[
				'import { formatDimensionNote } from "@earendil-works/pi-coding-agent";',
				'import { mjsRefs } from "./helper.mjs";',
				'import { esmJsRefs } from "./subpkg/index.js";',
				'import cjsRefs from "./helper.cjs";',
				"",
				"export default function (pi) {",
				"\t(globalThis as Record<string, unknown>).__piNativeEsmProbe = { tsFormat: formatDimensionNote, mjsRefs, esmJsRefs, cjsRefs };",
				'\tpi.registerCommand("probe", { description: "probe", handler: async () => {} });',
				"}",
			].join("\n"),
		);

		delete (globalThis as Record<string, unknown>).__piNativeEsmProbe;
		const result = await loadExtensions([extensionPath], root);
		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);

		const probe = (globalThis as Record<string, unknown>).__piNativeEsmProbe as {
			tsFormat: unknown;
			mjsRefs: { formatDimensionNote: unknown; resizeImage: unknown; Type: unknown };
			esmJsRefs: { truncateToWidth: unknown; registerFauxProvider: unknown };
			cjsRefs: { formatDimensionNote: unknown };
		};
		expect(probe.tsFormat).toBe(hostPiCodingAgent.formatDimensionNote);
		expect(probe.mjsRefs.formatDimensionNote).toBe(hostPiCodingAgent.formatDimensionNote);
		expect(probe.mjsRefs.resizeImage).toBe(hostPiCodingAgent.resizeImage);
		expect(probe.mjsRefs.Type).toBe(hostTypebox.Type);
		expect(probe.esmJsRefs.truncateToWidth).toBe(hostPiTui.truncateToWidth);
		expect(probe.esmJsRefs.registerFauxProvider).toBe(hostPiAi.registerFauxProvider);
		expect(probe.cjsRefs.formatDimensionNote).toBe(hostPiCodingAgent.formatDimensionNote);
	});

	it("prefers host modules over duplicate @earendil-works/* copies in an extension's node_modules", async () => {
		const root = createTempDir("pi-ext-shadow-nm-");
		const shadowPkgDir = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
		mkdirSync(shadowPkgDir, { recursive: true });
		writeFileSync(
			join(shadowPkgDir, "package.json"),
			JSON.stringify({ name: "@earendil-works/pi-coding-agent", type: "module", exports: "./index.js" }),
		);
		writeFileSync(
			join(shadowPkgDir, "index.js"),
			[
				"(globalThis.__piShadowCopyLoaded = ((globalThis.__piShadowCopyLoaded ?? 0) + 1));",
				"export function formatDimensionNote() { return 'shadow-copy'; }",
			].join("\n"),
		);

		writeFileSync(
			join(root, "tools.mjs"),
			'import { formatDimensionNote } from "@earendil-works/pi-coding-agent";\nexport { formatDimensionNote };\n',
		);
		const extensionPath = join(root, "macuse-like.ts");
		writeFileSync(
			extensionPath,
			[
				'import { formatDimensionNote } from "./tools.mjs";',
				"export default function (pi) {",
				"\t(globalThis as Record<string, unknown>).__piShadowResolved = formatDimensionNote;",
				'\tpi.registerCommand("shadow", { description: "shadow", handler: async () => {} });',
				"}",
			].join("\n"),
		);

		delete (globalThis as Record<string, unknown>).__piShadowCopyLoaded;
		delete (globalThis as Record<string, unknown>).__piShadowResolved;

		const result = await loadExtensions([extensionPath], root);
		expect(result.errors).toEqual([]);
		expect((globalThis as Record<string, unknown>).__piShadowCopyLoaded).toBeUndefined();
		expect((globalThis as Record<string, unknown>).__piShadowResolved).toBe(hostPiCodingAgent.formatDimensionNote);
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
