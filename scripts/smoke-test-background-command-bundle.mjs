#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const usage = `Usage: node scripts/smoke-test-background-command-bundle.mjs [cli.js]

Starts a held background job through the bundled CLI using an isolated faux provider,
then verifies that its worker finishes after the CLI exits. Requires built workspaces.

Example: node scripts/smoke-test-background-command-bundle.mjs packages/coding-agent/dist/bundle/cli.js
Exit codes: 0 passed/help; 1 failed or invalid arguments.
`;
const quote = value => `'${value.replaceAll("'", `'\\''`)}'`;

async function main() {
	if (process.argv.slice(2).some(argument => argument === "--help" || argument === "-h")) {
		process.stdout.write(usage);
		return;
	}
	if (process.argv.length > 3 || process.argv[2]?.startsWith("-")) throw new Error(usage);
	const cli = resolve(process.argv[2] ?? "packages/coding-agent/dist/bundle/cli.js");
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-background-bundle-")));
	const release = join(root, "release");
	const marker = "BUNDLED_BACKGROUND_WORKER_SURVIVED";
	const command = `${quote(process.execPath)} -e ${quote(`const fs = require('node:fs'); const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { console.log(${JSON.stringify(marker)}); clearInterval(timer); } }, 20);`)}`;
	let child;
	let job;
	try {
		const extension = join(root, "faux.mjs");
		await writeFile(extension, `
import { registerFauxProvider, getApiProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(new URL("../packages/ai/dist/compat.js", import.meta.url).href)};
export default function (pi) {
  const faux = registerFauxProvider({ provider: "background-smoke", api: "background-smoke", models: [{ id: "background-smoke" }] });
  const model = faux.getModel();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("background_command", { action: "start", command: ${JSON.stringify(command)}, timeout: 30 }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Background job launched"),
  ]);
  pi.registerProvider(model.provider, {
    api: faux.api, baseUrl: model.baseUrl, apiKey: "faux-key",
    streamSimple: getApiProvider(faux.api).streamSimple,
    models: [{ id: model.id, name: model.name, input: model.input, reasoning: false,
      cost: model.cost, contextWindow: model.contextWindow, maxTokens: model.maxTokens }],
  });
}
`);
		child = spawn(process.execPath, [cli, "--provider", "background-smoke", "--model", "background-smoke",
			"--mode", "json", "--tools", "background_command", "--no-session", "--offline", "--no-context-files",
			"--no-skills", "--no-prompt-templates", "--no-themes", "--no-extensions", "-e", "builtin:background-command", "-e", extension, "Start the held job"], {
			cwd: root,
			env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: root, PI_PACKAGE_DIR: resolve(dirname(cli), "../.."), PI_OFFLINE: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", chunk => { stdout += String(chunk); });
		child.stderr.on("data", chunk => { stderr += String(chunk); });
		const exitCode = await new Promise((resolveExit, reject) => {
			const timer = setTimeout(() => { child.kill(); reject(new Error("Bundled CLI timed out")); }, 30_000);
			child.once("error", error => { clearTimeout(timer); reject(error); });
			child.once("close", code => { clearTimeout(timer); resolveExit(code); });
		});
		assert.equal(exitCode, 0, `CLI failed: ${stderr.slice(-8192)}\n${stdout.slice(-8192)}`);
		const result = stdout.trim().split("\n").map(line => JSON.parse(line)).find(event => event.type === "tool_execution_end" && event.toolName === "background_command");
		assert.ok(result && !result.isError, `No successful background start: ${stdout.slice(-8192)}`);
		job = result.result.details;
		assert.ok(job.logFile.startsWith(root));
		const stateFile = join(dirname(job.logFile), "state.json");
		assert.equal(JSON.parse(await readFile(stateFile, "utf8")).status, "running");
		await writeFile(release, "go");
		let state;
		for (let i = 0; i < 250; i++) {
			state = JSON.parse(await readFile(stateFile, "utf8"));
			if (state.status !== "running") break;
			await delay(20);
		}
		assert.equal(state.status, "succeeded");
		assert.equal(await readFile(job.logFile, "utf8"), `${marker}\n`);
		console.log("PASS: dist/bundle/cli.js launched its shipped worker; the job finished after CLI exit with intact raw output.");
	} finally {
		if (child?.exitCode === null) child.kill();
		await writeFile(release, "go");
		if (job?.pid) {
			for (let i = 0; i < 250; i++) {
				try { process.kill(job.pid, 0); } catch { break; }
				await delay(20);
			}
		}
		await rm(root, { recursive: true, force: true });
	}
}

main().catch(error => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
