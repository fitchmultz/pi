import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { writeUpstreamMock } from "./catalog-generation-utils.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

/**
 * Generate the catalog JSON into a temporary directory. The first `drops` requests for the models.dev catalog
 * reach a local server that sends half a response and then resets the connection; every other request gets
 * the upstream mock.
 */
function generateWithDroppedConnections(drops: number, mode: "strict" | "lenient") {
	const root = mkdtempSync(join(tmpdir(), "pi-catalog-connection-"));
	temporaryRoots.push(root);
	const mockPath = join(root, "mock-catalog.mjs");
	const outputPath = join(root, "catalog");
	writeUpstreamMock(mockPath, {
		opencode: {
			models: {
				chat: {
					id: "chat",
					type: "chat",
					name: "chat",
					modalities: { input: ["text"], output: ["text"] },
					capabilities: { tools: { supported: true }, reasoning: { supported: false } },
					api: { "chat-completions": { base_url: "https://example.test/v1" } },
				},
			},
		},
	});
	const preloadPath = join(root, "drop-connections.mjs");
	writeFileSync(
		preloadPath,
		`import { createServer } from "node:http";\n` +
			`const realFetch = globalThis.fetch;\n` +
			`await import(${JSON.stringify(pathToFileURL(mockPath).href)});\n` +
			`const mockFetch = globalThis.fetch;\n` +
			`const server = createServer((request, response) => {\n` +
			`  response.writeHead(200, { "content-type": "application/json", "content-length": "1000" });\n` +
			`  response.write('{"opencode": ', () => request.socket.resetAndDestroy());\n` +
			`});\n` +
			`await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));\n` +
			`server.unref();\n` +
			`let drops = ${drops};\n` +
			`globalThis.fetch = async (input, init) => {\n` +
			`  if (String(input) !== "https://models.dev/experimental/v2.0/api.json" || drops-- <= 0) return mockFetch(input, init);\n` +
			`  return realFetch(\`http://127.0.0.1:\${server.address().port}/\`, init);\n` +
			`};\n`,
	);
	const result = spawnSync(
		process.execPath,
		[
			"--import",
			pathToFileURL(preloadPath).href,
			"catalog/generate.ts",
			...(mode === "strict" ? ["--strict"] : []),
			"--json-only",
			"--json-output",
			outputPath,
		],
		{ cwd: packageRoot, encoding: "utf8", timeout: 10_000 },
	);
	return {
		result,
		opencodeModelIds: () =>
			Object.keys(JSON.parse(readFileSync(join(outputPath, "providers/opencode.json"), "utf8")) as object),
	};
}

describe("catalog source connections", () => {
	it("fetches a source once more when its connection drops", () => {
		const { result, opencodeModelIds } = generateWithDroppedConnections(1, "lenient");
		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(result.stderr).not.toContain("Failed to fetch models.dev catalog");
		expect(opencodeModelIds()).toEqual(["chat"]);
	});

	it("fails strict generation when the second connection drops too", () => {
		const { result } = generateWithDroppedConnections(2, "strict");
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Failed to fetch models.dev catalog: TypeError");
	});
});
