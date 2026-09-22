import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test.for(["source", "modular", "bundled"])(
	"publishes from a dependency-free extension through the %s CLI",
	(mode, { onTestFinished }) => {
		const root = mkdtempSync(join(tmpdir(), "pi-publication-extension-"));
		onTestFinished(() => rmSync(root, { recursive: true, force: true }));
		const extension = join(root, "publish.ts");
		const target = join(root, "published.txt");
		writeFileSync(
			extension,
			`import assert from "node:assert/strict";
import { publishLocalFile, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import * as portableCore from "@earendil-works/pi-agent-core";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
export default async function(pi) {
  assert.equal("publishLocalFile" in portableCore, false);
  await withFileMutationQueue(${JSON.stringify(target)}, () => publishLocalFile(${JSON.stringify(target)}, "complete"));
  const faux = fauxProvider({ api: "publication-test", provider: "publication-test" });
  faux.setResponses([fauxAssistantMessage("publication passed")]);
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
				"publication-test",
				"--model",
				"faux-1",
				"test publication",
			],
			{
				cwd: root,
				env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: root, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
				encoding: "utf8",
				timeout: 30_000,
			},
		);
		expect(output.trim()).toBe("publication passed");
		expect(readFileSync(target, "utf8")).toBe("complete");
	},
);
