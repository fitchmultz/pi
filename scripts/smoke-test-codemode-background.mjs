#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const usage = `Usage: node scripts/smoke-test-codemode-background.mjs [dist-dir] [ai-compat.js]

Runs a held background codemode script through the built SDK and an in-process faux provider,
then verifies that the foreground turn finishes first and the completion arrives with real output.
Requires built workspaces (npm run build).

Example: node scripts/smoke-test-codemode-background.mjs packages/coding-agent/dist
Exit codes: 0 passed/help; 1 failed or invalid arguments.
`;

function resolveDist(argument) {
	const directory = resolve(argument ?? "packages/coding-agent/dist");
	if (!existsSync(join(directory, "index.js"))) {
		throw new Error(
			`No index.js in ${directory}. Build the workspaces first, or pass the package's dist directory.`,
		);
	}
	return directory;
}

/**
 * The built `@earendil-works/pi-ai/compat` entry, which carries the faux provider.
 * A checkout keeps it beside the coding-agent package; an installed pi has its own copy.
 */
function resolveAiCompat(dist, argument) {
	const candidates = [
		...(argument ? [resolve(argument)] : []),
		resolve(dist, "../../ai/dist/compat.js"),
		resolve(dist, "../node_modules/@earendil-works/pi-ai/dist/compat.js"),
		resolve(dist, "../../../@earendil-works/pi-ai/dist/compat.js"),
		resolve(dist, "../../node_modules/@earendil-works/pi-ai/dist/compat.js"),
	];
	const found = candidates.find((path) => existsSync(path));
	if (!found) {
		throw new Error(
			`No @earendil-works/pi-ai compat build. Tried:\n${candidates.map((path) => `  ${path}`).join("\n")}`,
		);
	}
	return found;
}

/**
 * The entry runs in a child so its imports of the built packages stay static, like
 * `smoke-test-background-command-bundle.mjs`: the artifact under test is chosen by path, not by a
 * dynamic import.
 */
function entrySource(dist, aiCompat) {
	return `import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, createCodemodeExtension, DefaultResourceLoader, ModelRuntime, SessionManager } from ${JSON.stringify(pathToFileURL(join(dist, "index.js")).href)};
import { fauxAssistantMessage, fauxToolCall, getApiProvider, registerFauxProvider } from ${JSON.stringify(pathToFileURL(aiCompat).href)};

const root = await mkdtemp(join(tmpdir(), "pi-codemode-background-"));
let session;
try {
	const gate = { started: Promise.withResolvers(), released: Promise.withResolvers() };
	const faux = registerFauxProvider({ provider: "codemode-smoke", models: [{ id: "codemode-smoke" }] });
	faux.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall("codemode", {
					code: '// @options: {"background": true}\\nconst result = await tools.held({});\\ntext(\`script saw \${result}\`);',
				}),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("foreground finished"),
		fauxAssistantMessage("completion handled"),
	]);

	const model = faux.getModel();
	const modelRuntime = await ModelRuntime.create({
		authPath: join(root, "auth.json"),
		modelsPath: join(root, "models.json"),
	});
	modelRuntime.registerProvider(model.provider, {
		api: faux.api,
		baseUrl: model.baseUrl,
		apiKey: "faux-key",
		streamSimple: getApiProvider(faux.api).streamSimple,
		models: [
			{
				id: model.id,
				name: model.name,
				input: model.input,
				reasoning: false,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
			},
		],
	});

	const loader = new DefaultResourceLoader({
		cwd: root,
		agentDir: root,
		extensionFactories: [
			createCodemodeExtension(),
			(pi) =>
				pi.registerTool({
					name: "held",
					label: "held",
					description: "Waits until the smoke test releases it",
					parameters: { type: "object", properties: {}, additionalProperties: false },
					execute: async () => {
						gate.started.resolve();
						await gate.released.promise;
						return { content: [{ type: "text", text: "held output" }], details: undefined };
					},
				}),
		],
	});
	await loader.reload();

	const created = await createAgentSession({
		cwd: root,
		agentDir: root,
		model,
		modelRuntime,
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(),
		tools: ["codemode", "held"],
	});
	session = created.session;
	assert.deepEqual(created.extensionsResult.errors, [], "extension load errors");

	const completion = Promise.withResolvers();
	session.subscribe((event) => {
		if (event.type === "message_end" && event.message.role === "custom") completion.resolve(event.message);
	});

	await session.prompt("run the held script in the background");

	const receipt = session.messages.findLast(
		(message) => message.role === "toolResult" && message.toolName === "codemode",
	);
	assert.ok(receipt, "no codemode receipt");
	assert.equal(receipt.isError, false, "the receipt is an error");
	assert.deepEqual(receipt.details, { calls: [], background: { runId: receipt.toolCallId } });
	assert.deepEqual(receipt.content, [
		{
			type: "text",
			text: \`Script running in background.\\nRun \${receipt.toolCallId}. Its result arrives as a message when the script finishes.\`,
		},
	]);
	assert.equal(session.getLastAssistantText(), "foreground finished", "the turn did not continue past the receipt");
	assert.ok(
		!session.messages.some((message) => message.role === "custom"),
		"a completion arrived before the held script finished",
	);

	gate.released.resolve();
	const expired = new Promise((_resolve, reject) =>
		setTimeout(() => reject(new Error("No completion message")), 20_000).unref(),
	);
	const message = await Promise.race([completion.promise, expired]);

	assert.equal(message.customType, "codemode-background");
	assert.equal(message.details.runId, receipt.toolCallId);
	assert.equal(message.details.isError, false);
	assert.deepEqual(
		message.details.resultDetails.calls.map((call) => [call.name, call.status]),
		[["held", "ok"]],
	);
	const text = message.content.map((block) => (block.type === "text" ? block.text : \`<\${block.type}>\`)).join("");
	assert.ok(
		text.startsWith(\`Background run \${receipt.toolCallId} completed.\\nScript completed\\n\`),
		\`unexpected completion text: \${text}\`,
	);
	assert.ok(text.includes("script saw held output"), \`missing script output: \${text}\`);
	for (let attempt = 0; attempt < 100 && session.getLastAssistantText() !== "completion handled"; attempt++) {
		await new Promise((resolveWait) => setTimeout(resolveWait, 50));
	}
	assert.equal(session.getLastAssistantText(), "completion handled", "the completion did not start a turn");

	process.stdout.write(
		\`PASS codemode background: receipt \${receipt.toolCallId}, foreground finished first, completion delivered with the script output\\n\`,
	);
} finally {
	session?.dispose();
	await rm(root, { recursive: true, force: true });
}
`;
}

async function main() {
	if (process.argv.slice(2).some((argument) => argument === "--help" || argument === "-h")) {
		process.stdout.write(usage);
		return;
	}
	if (process.argv.length > 4) throw new Error(usage);
	const dist = resolveDist(process.argv[2]);
	const aiCompat = resolveAiCompat(dist, process.argv[3]);
	const root = await mkdtemp(join(tmpdir(), "pi-codemode-background-run-"));
	const entry = join(root, "smoke.mjs");
	try {
		await writeFile(entry, entrySource(dist, aiCompat));
		// The provider must be offline and deterministic: no credentials, no network, no paid calls.
		execFileSync(process.execPath, [entry], {
			cwd: root,
			stdio: "inherit",
			timeout: 60_000,
			env: { PATH: process.env.PATH, HOME: root, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
	process.exitCode = 1;
});
