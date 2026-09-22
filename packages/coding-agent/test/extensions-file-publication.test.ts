import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test.for(["source", "modular", "bundled"])(
	"shares extension mutation locks with native and harness writes through the %s CLI",
	(mode, { onTestFinished }) => {
		const root = mkdtempSync(join(tmpdir(), "pi-publication-extension-"));
		onTestFinished(() => rmSync(root, { recursive: true, force: true }));
		const extension = join(root, "publish.ts");
		const target = join(root, "published.txt");
		writeFileSync(
			extension,
			`import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { createWriteTool, publishLocalFile, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import * as portableCore from "@earendil-works/pi-agent-core";
import * as nodeCore from "@earendil-works/pi-agent-core/node";
import * as legacyNodeCore from "@mariozechner/pi-agent-core/node";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
export default async function(pi) {
  assert.equal("publishLocalFile" in portableCore, false);
  assert.equal("withFileMutationQueue" in portableCore, false);
  assert.equal(nodeCore.withFileMutationQueue, legacyNodeCore.withFileMutationQueue);
  const target = ${JSON.stringify(target)};
  await withFileMutationQueue(target, () => publishLocalFile(target, "initial"));
  const env = new nodeCore.NodeExecutionEnv({ cwd: ${JSON.stringify(root)} });
  const writers = [
    ["native", () => createWriteTool(${JSON.stringify(root)}).execute("native-write", { path: target, content: "native" })],
    ["harness", () => portableCore.createWriteTool().execute(
      "harness-write", { path: target, content: "harness" }, () => {}, { env },
      { invocationId: "publication-test", operationId: "write", turnId: "turn", getMemo: async () => undefined, setMemo: async () => {} }, portableCore.BACKGROUND_CONTEXT,
    )],
  ];
  for (const [label, write] of writers) {
    const before = await readFile(target, "utf8");
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const lock = withFileMutationQueue(target, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const pending = write();
    try {
      assert.equal(
        await Promise.race([pending.then(() => "published"), setTimeout(100, "blocked")]),
        "blocked", label + " write bypassed the extension lock",
      );
      assert.equal(await readFile(target, "utf8"), before);
    } finally {
      release.resolve();
    }
    await Promise.all([lock, pending]);
    assert.equal(await readFile(target, "utf8"), label);
  }
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
		expect(readFileSync(target, "utf8")).toBe("harness");
	},
);
