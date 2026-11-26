import assert from "node:assert";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getNativeModuleCandidates } from "../src/native-module-path.ts";

describe("getNativeModuleCandidates", () => {
	it("resolves native helpers from the installed TUI package when the module is bundled elsewhere", () => {
		const packageRoot = resolve("virtual", "node_modules", "@earendil-works", "pi-tui");
		const bundledModule = resolve("virtual", "pi-coding-agent", "dist", "bundle", "chunks", "chunk.js");
		const nativePath = join("native", "win32", "prebuilds", "win32-arm64", "win32-platform.node");

		const candidates = getNativeModuleCandidates(nativePath, {
			moduleUrl: pathToFileURL(bundledModule).href,
			execPath: resolve("virtual", "node", "node.exe"),
			resolvePackage: (specifier) => {
				assert.equal(specifier, "@earendil-works/pi-tui");
				return join(packageRoot, "dist", "index.js");
			},
		});

		assert.equal(candidates[0], join(packageRoot, nativePath));
		assert.ok(candidates.includes(join(dirname(bundledModule), "..", nativePath)));
	});

	it("keeps standalone binary fallbacks when the TUI package is unavailable", () => {
		const bundledModule = resolve("virtual", "pi", "bundle", "chunks", "chunk.js");
		const execPath = resolve("virtual", "pi", "pi.exe");
		const nativePath = join("native", "darwin", "prebuilds", "darwin-arm64", "darwin-platform.node");

		const candidates = getNativeModuleCandidates(nativePath, {
			moduleUrl: pathToFileURL(bundledModule).href,
			execPath,
			resolvePackage: () => {
				throw new Error("not installed");
			},
		});

		assert.deepEqual(candidates, [
			join(dirname(bundledModule), "..", nativePath),
			join(dirname(bundledModule), nativePath),
			join(dirname(execPath), nativePath),
		]);
	});

	it("resolves all public package exports via both createRequire and ESM import.meta.resolve from an installed layout", async () => {
		const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "pi-tui-exports-")));
		try {
			const pkgDir = join(fixtureRoot, "node_modules", "@earendil-works", "pi-tui");
			const nativePath = join("native", "darwin", "prebuilds", "darwin-arm64", "pi_tui_clipboard.node");
			mkdirSync(join(pkgDir, "dist"), { recursive: true });
			mkdirSync(dirname(join(pkgDir, nativePath)), { recursive: true });
			copyFileSync(new URL("../package.json", import.meta.url), join(pkgDir, "package.json"));
			writeFileSync(join(pkgDir, "dist", "index.js"), "export {};\n");
			writeFileSync(
				join(pkgDir, "dist", "exif-orientation.js"),
				"export function getExifOrientation() { return 1; }\n",
			);
			writeFileSync(join(pkgDir, "dist", "layout.js"), "export {};\n");
			writeFileSync(join(pkgDir, nativePath), "");

			const callerDir = join(
				fixtureRoot,
				"node_modules",
				"@earendil-works",
				"pi-coding-agent",
				"dist",
				"bundle",
				"chunks",
			);
			mkdirSync(callerDir, { recursive: true });
			const callerPath = join(callerDir, "chunk.mjs");
			writeFileSync(callerPath, "export const resolveEsm = (specifier) => import.meta.resolve(specifier);\n");
			const callerUrl = pathToFileURL(callerPath).href;
			const req = createRequire(callerPath);
			const { resolveEsm } = (await import(callerUrl)) as { resolveEsm: (specifier: string) => string };

			const expected: Array<[string, string]> = [
				["@earendil-works/pi-tui", join(pkgDir, "dist", "index.js")],
				["@earendil-works/pi-tui/exif-orientation", join(pkgDir, "dist", "exif-orientation.js")],
				["@earendil-works/pi-tui/dist/index.js", join(pkgDir, "dist", "index.js")],
				["@earendil-works/pi-tui/dist/layout.js", join(pkgDir, "dist", "layout.js")],
				["@earendil-works/pi-tui/package.json", join(pkgDir, "package.json")],
				[`@earendil-works/pi-tui/${nativePath.replaceAll("\\", "/")}`, join(pkgDir, nativePath)],
			];

			for (const [specifier, target] of expected) {
				assert.equal(req.resolve(specifier), target, `createRequire.resolve failed for ${specifier}`);
				assert.equal(fileURLToPath(resolveEsm(specifier)), target, `import.meta.resolve failed for ${specifier}`);
			}

			const candidates = getNativeModuleCandidates(nativePath, {
				moduleUrl: callerUrl,
				execPath: join(fixtureRoot, "node"),
				resolvePackage: (specifier) => req.resolve(specifier),
			});
			assert.equal(candidates[0], join(pkgDir, nativePath));
		} finally {
			rmSync(fixtureRoot, { force: true, recursive: true });
		}
	});
});
