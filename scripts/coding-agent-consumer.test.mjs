import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { installCodingAgentConsumer, packReleasePackages, smokeTestCodingAgentConsumer } from "./coding-agent-consumer.mjs";

const codingAgentName = "@earendil-works/pi-coding-agent";
const devPackages = ["pi-client", "pi-protocol", "pi-server"].map((name) => `@earendil-works/${name}`);

function createFixture(t, { importServer = false, declareServer = false, frozenExternal = false } = {}) {
	const root = mkdtempSync(join(tmpdir(), "pi-consumer-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const packages = [codingAgentName, "@earendil-works/chord", ...devPackages].map((name) => ({
		name,
		directory: join(root, "packages", name.split("/")[1]),
	}));
	const lockDirectory = join(root, "install-lock");
	const installer = {
		private: true,
		dependencies: { [codingAgentName]: "1.0.0" },
		overrides: { protobufjs: "7.6.6" },
	};
	const lock = { lockfileVersion: 3, requires: true, packages: { "": installer } };
	if (frozenExternal) {
		const external = { name: "pi-consumer-external", directory: join(root, "external") };
		mkdirSync(external.directory);
		writeFileSync(join(external.directory, "package.json"), JSON.stringify({ name: external.name, version: "1.0.0" }));
		const tarball = packReleasePackages([external], join(root, "external-tarballs")).get(external.name);
		lock.packages[`node_modules/${external.name}`] = {
			version: "1.0.0",
			resolved: `file:${tarball}`,
			integrity: `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`,
		};
	}
	for (const pkg of packages) {
		const isAgent = pkg.name === codingAgentName;
		const manifest = {
			name: pkg.name,
			version: "1.0.0",
			type: "module",
			exports: isAgent ? {
				".": "./dist/index.js",
				"./client": { source: "./src/client/index.ts" },
				"./experimental/plugin": { source: "./src/experimental/plugin.ts" },
			} : "./dist/index.js",
			...(isAgent ? {
				bin: { pi: "dist/bundle/cli.js" },
				dependencies: {
					"@earendil-works/chord": "1.0.0",
					...(frozenExternal ? { "pi-consumer-external": "^1.0.0" } : {}),
					...(declareServer ? { "@earendil-works/pi-server": "1.0.0" } : {}),
				},
				devDependencies: Object.fromEntries(devPackages.map((name) => [name, "1.0.0"])),
			} : {}),
		};
		if (!devPackages.includes(pkg.name) || (declareServer && pkg.name === "@earendil-works/pi-server")) {
			lock.packages[`node_modules/${pkg.name}`] = {
				version: manifest.version,
				dependencies: manifest.dependencies,
				bin: manifest.bin,
				resolved: `https://registry.npmjs.org/${pkg.name}/-/unused.tgz`,
			};
		}
		const files = {
			"package.json": JSON.stringify(manifest),
			"dist/index.js": isAgent ? `
${importServer ? 'import "@earendil-works/pi-server";' : ""}
import { marker } from "@earendil-works/chord";
if (marker !== "local tarball") throw new Error("Wrong Chord artifact");
export function createAgentSession() {}
export class SessionManager { static inMemory() {} }
export class ModelRuntime { static create() {} }
` : 'export const marker = "local tarball";',
			...(isAgent ? {
				"dist/cli.js": 'console.log("1.0.0");',
				"dist/bundle/cli.js": 'console.log("1.0.0");',
			} : {}),
		};
		for (const [path, content] of Object.entries(files)) {
			mkdirSync(dirname(join(pkg.directory, path)), { recursive: true });
			writeFileSync(join(pkg.directory, path), content);
		}
		if (isAgent && frozenExternal) {
			writeFileSync(join(pkg.directory, "npm-shrinkwrap.json"), JSON.stringify({
				lockfileVersion: 3,
				packages: { "": manifest, "node_modules/pi-consumer-external": lock.packages["node_modules/pi-consumer-external"] },
			}));
		}
	}
	mkdirSync(lockDirectory);
	writeFileSync(join(lockDirectory, "package.json"), JSON.stringify(installer));
	writeFileSync(join(lockDirectory, "package-lock.json"), JSON.stringify(lock));
	const tarballs = packReleasePackages(packages, join(root, "tarballs"));
	const directory = join(root, "consumer");
	installCodingAgentConsumer(directory, tarballs, "npm", {
		lockDirectory,
		env: { ...process.env, npm_config_offline: "true", npm_config_cache: join(root, "cache") },
	});
	return directory;
}

// #9132: installing every tarball directly hid undeclared runtime imports.
test("installs only coding-agent directly and uses overrides only for declared runtime dependencies", (t) => {
	const directory = createFixture(t);
	const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
	assert.deepEqual(Object.keys(manifest.dependencies), [codingAgentName]);
	for (const name of devPackages) {
		assert.ok(manifest.overrides[name]);
		assert.equal(existsSync(join(directory, "node_modules", name)), false);
	}
	smokeTestCodingAgentConsumer(directory);

	const nested = join(directory, "node_modules", codingAgentName, "node_modules/@earendil-works/pi-server");
	mkdirSync(nested, { recursive: true });
	writeFileSync(join(nested, "package.json"), JSON.stringify({ name: "@earendil-works/pi-server", version: "1.0.0" }));
	assert.throws(() => smokeTestCodingAgentConsumer(directory), /pi-server must not be installed/);
	rmSync(nested, { recursive: true });

	const experimental = join(directory, "node_modules", codingAgentName, "dist/experimental");
	mkdirSync(experimental);
	assert.throws(() => smokeTestCodingAgentConsumer(directory), /contains development-only code/);
});

test("consumes frozen external resolutions instead of resolving a local tarball's semver dependencies again", (t) => {
	// npm's local-file metadata omits hasShrinkwrap, so the nested shrinkwrap alone is insufficient.
	const directory = createFixture(t, { frozenExternal: true });
	const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
	const lock = JSON.parse(readFileSync(join(directory, "package-lock.json"), "utf8"));
	assert.equal(manifest.overrides.protobufjs, "7.6.6");
	assert.equal(lock.packages["node_modules/pi-consumer-external"].version, "1.0.0");
	assert.equal(JSON.parse(readFileSync(join(directory, "node_modules/pi-consumer-external/package.json"), "utf8")).version, "1.0.0");
	assert.ok(existsSync(join(directory, "node_modules", codingAgentName, "npm-shrinkwrap.json")));
	smokeTestCodingAgentConsumer(directory);
});

// #9132: smoke-test the public SDK, not just a bundled CLI that hides missing imports.
test("fails when the SDK imports an undeclared server despite a working CLI", (t) => {
	const directory = createFixture(t, { importServer: true });
	assert.throws(() => smokeTestCodingAgentConsumer(directory), /Cannot find package '@earendil-works\/pi-server'/);
});

test("fails if a development-only dependency is added back to the published dependency tree", (t) => {
	const directory = createFixture(t, { declareServer: true });
	assert.throws(() => smokeTestCodingAgentConsumer(directory), /pi-server must not be installed/);
});
