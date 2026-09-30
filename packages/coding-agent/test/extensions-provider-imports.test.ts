import { execFileSync } from "node:child_process";
import { globSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "vitest";

test.for(["source", "modular", "bundled"])(
	"loads models and standalone provider imports through the %s CLI",
	(mode, { onTestFinished }) => {
		const root = mkdtempSync(join(tmpdir(), "pi-provider-imports-"));
		onTestFinished(() => rmSync(root, { recursive: true, force: true }));
		const providersDir = fileURLToPath(new URL("../../ai/dist/providers/", import.meta.url));
		const modules = globSync("**/*.js", { cwd: providersDir }).sort();
		const imports = modules.map((file, index) => {
			const subpath = file.replaceAll("\\", "/").slice(0, -3);
			return `import * as modern${index} from "@earendil-works/pi-ai/providers/${subpath}";
import * as legacy${index} from "@mariozechner/pi-ai/providers/${subpath}";
import * as expected${index} from ${JSON.stringify(pathToFileURL(join(providersDir, file)).href)};`;
		});
		const checks = modules.map(
			(file, index) => `
assert.deepEqual(Object.keys(modern${index}).sort(), Object.keys(expected${index}).sort(), ${JSON.stringify(file)});
assert.deepEqual(Object.keys(legacy${index}).sort(), Object.keys(expected${index}).sort(), ${JSON.stringify(file)});
for (const key of Object.keys(expected${index})) {
  assert.equal(modern${index}[key], legacy${index}[key], ${JSON.stringify(file)} + ": " + key);
  assert.equal(typeof modern${index}[key], typeof expected${index}[key]);
  if (typeof expected${index}[key] !== "function") assert.deepEqual(modern${index}[key], expected${index}[key]);
}`,
		);
		const extension = join(root, "providers.ts");
		writeFileSync(
			extension,
			`import assert from "node:assert/strict";
import { createModels as rootCreateModels, fauxProvider as rootFauxProvider } from "@earendil-works/pi-ai";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
${imports.join("\n")}
export default async function(pi) {
  ${checks.join("\n")}
  assert.equal(fauxProvider, rootFauxProvider);
  assert.equal(createModels, rootCreateModels);
  assert.equal(typeof createProvider, "function");
  const models = createModels();
  assert.deepEqual(models.getModels(), []);
  assert.deepEqual(models.getProviders(), []);
  const faux = fauxProvider({ api: "provider-imports", provider: "provider-imports" });
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("models subpath passed"), fauxAssistantMessage("all provider imports passed")]);
  const response = await models.completeSimple(faux.getModel(), { messages: [] });
  assert.equal(response.stopReason, "stop");
  assert.deepEqual(response.content, [{ type: "text", text: "models subpath passed" }]);
  pi.registerProvider(faux.provider);
}
`,
		);
		const cli = fileURLToPath(
			new URL(
				mode === "source" ? "../src/cli.ts" : mode === "modular" ? "../dist/cli.js" : "../dist/bundle/cli.js",
				import.meta.url,
			),
		);
		const args =
			mode === "source"
				? ["--import", fileURLToPath(new URL("../src/experimental/source-resolver.ts", import.meta.url)), cli]
				: [cli];
		const output = execFileSync(
			process.execPath,
			[
				...args,
				"--print",
				"--no-session",
				"--no-tools",
				"--no-extensions",
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"-e",
				extension,
				"--provider",
				"provider-imports",
				"--model",
				"faux-1",
				"test imports",
			],
			{
				cwd: root,
				env: {
					PATH: process.env.PATH,
					HOME: root,
					TMPDIR: root,
					XDG_CACHE_HOME: root,
					JITI_FS_CACHE: "0",
					PI_CODING_AGENT_DIR: root,
					PI_OFFLINE: "1",
					PI_TELEMETRY: "0",
				},
				encoding: "utf8",
				timeout: 30_000,
			},
		);
		expect(modules.length).toBeGreaterThan(0);
		expect(output.trim()).toBe("all provider imports passed");
	},
);
