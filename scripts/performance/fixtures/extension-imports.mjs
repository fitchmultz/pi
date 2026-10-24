import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import { networkInterfaces } from "node:os";
import { transformSync, version as compilerVersion } from "esbuild";
import { loadExtensions } from "/pi-performance-source/packages/coding-agent/dist/core/extensions/loader.js";
import { sha256, witness } from "../proof.mjs";

const [workload, mode, diagnosticArg] = process.argv.slice(2);
assert.ok(["esm", "async", "cpu"].includes(workload), "expected esm, async or cpu workload");
assert.ok(["loader", "unbundled", "bundled", "embedded"].includes(mode), "unknown runtime boundary");
const diagnostic = diagnosticArg === "diagnostic";
// Compiled Bun does not accept runtime preloads. Use the documented OS network namespace, not a test loader seam.
if (mode === "embedded") {
	assert.equal(process.platform, "linux", "embedded performance fixture currently owns Linux only");
	assert.deepEqual(
		networkInterfaces(),
		{},
		"embedded cases require an isolated network namespace with no IP interfaces",
	);
}
const root = process.env.PI_PERF_REPO;
const evidence = process.env.PI_PERF_EVIDENCE_DIR;
assert.ok(evidence, "use run.mjs to retain actual JSONL and generated inputs outside scratch");
mkdirSync(evidence, { recursive: true });
const fixture = join(evidence, "package");
const tracePath = join(evidence, "imports.jsonl");
writeFileSync(tracePath, "", { flag: "wx" });
const names = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];
const files = {};
function file(name, source, compile = false) {
	if (compile) {
		const sourcePath = join(evidence, "sources", name.replace(/\.js$/, ".ts"));
		mkdirSync(dirname(sourcePath), { recursive: true });
		writeFileSync(sourcePath, source);
	}
	const contents = compile ? transformSync(source, { loader: "ts", format: "esm", target: "es2022" }).code : source;
	const path = join(fixture, name);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, contents);
	files[name] = sha256(contents);
	return path;
}
const recorder = `import { appendFileSync } from "node:fs";
const record = (type, name) => appendFileSync(process.env.PI_PERF_EXTENSION_TRACE, JSON.stringify({ type, name }) + "\\n");`;
const dependency = (name) => `${recorder}\nrecord("dependency", "${name}");\n`;
if (workload === "esm") {
	file("package.json", JSON.stringify({ name: "pi-performance-extension-imports", version: "0.0.0", type: "module" }));
	file("shared/labels.js", `${dependency("shared/labels")}export const label: string = "Synthetic";`, true);
	file(
		"shared/format.js",
		`${dependency("shared/format")}import { label } from "./labels.js";
export const format = (name: string, checksum: number) => label + " " + name + ":" + checksum + " tool";`,
		true,
	);
}
const descriptions = names.map(
	(name) => `Synthetic ${name}:${workload === "esm" ? 136 : workload === "cpu" ? 1999 : 0} tool`,
);
const paths = names.map((name, index) => {
	if (workload === "esm") {
		file(
			`${name}/values.js`,
			`${dependency(`${name}/values`)}export const values: number[] = [${Array.from({ length: 16 }, (_, i) => i + 1)}];`,
			true,
		);
		file(
			`${name}/schema.js`,
			`${dependency(`${name}/schema`)}import { values } from "./values.js";
export const checksum = values.reduce((sum, value) => sum + value, 0);
export const parameters = { type: "object", properties: { value: { type: "number", enum: values } } };`,
			true,
		);
		file(
			`${name}/metadata.js`,
			`${dependency(`${name}/metadata`)}import { checksum, parameters } from "./schema.js";
import { format } from "../shared/format.js";
export { parameters };
export const description = format("${name}", checksum);`,
			true,
		);
	}
	const setup =
		workload === "esm"
			? 'import { description, parameters } from "./metadata.js";'
			: `${workload === "cpu" ? Array.from({ length: 2000 }, (_, i) => `const value${i}: number = ${i};`).join("\n") : ""}
const description = "Synthetic ${name}:" + ${workload === "cpu" ? "value1999" : "0"} + " tool";
const parameters = { type: "object", properties: {} };`;
	return file(
		workload === "esm" ? `${name}/index.js` : `${name}.ts`,
		`${recorder}
${setup}
record("import:start", "${name}");
${workload === "esm" ? "" : `await new Promise(resolve => setTimeout(resolve, ${workload === "async" ? [60, 50, 40, 30, 20, 10][index] : 0}));`}
record("import:end", "${name}");
export default ${workload === "esm" ? "" : "async "}function(pi) {
 record("factory:start", "${name}");
 ${workload === "esm" ? "" : "await new Promise(resolve => setTimeout(resolve, 2));"}
 pi.registerTool({ name: "${name}", label: "${name}", description, parameters,
  execute: async () => ({ content: [{ type: "text", text: "ok" }] }) });
 pi.registerCommand("${name}", { description, handler: async () => {} });
 pi.registerFlag("${name}-flag", { type: "string", default: "${name}" });
 record("factory:end", "${name}");
}`,
		workload === "esm",
	);
});
writeFileSync(join(evidence, "inputs.json"), `${JSON.stringify({ workload, compilerVersion, files }, null, 2)}\n`);
const artifactNames = [
	"dist/core/extensions/loader.js",
	"dist/cli.js",
	"dist/bundle/cli.js",
	"dist/bundle/rpc-entry.js",
];
const embedded = join(root, ".artifacts/performance/extension-imports/linux-x64/pi");
for (const name of artifactNames) {
	console.log(
		JSON.stringify({
			sourceArtifact: {
				name: `packages/coding-agent/${name}`,
				sha256: sha256(readFileSync(join(root, "packages/coding-agent", name))),
			},
		}),
	);
}
if (mode === "embedded")
	console.log(
		JSON.stringify({ sourceArtifact: { name: relative(root, embedded), sha256: sha256(readFileSync(embedded)) } }),
	);
const env = {
	...process.env,
	PI_PERF_EXTENSION_TRACE: tracePath,
	JITI_FS_CACHE: "0",
	JITI_DEBUG: diagnostic ? "1" : "0",
	PI_TIMING: diagnostic ? "1" : "0",
};
const responses = [];
let commands;
let elapsedMs;
let stdout = "";
let stderr = "";
if (mode === "loader") {
	Object.assign(process.env, { PI_PERF_EXTENSION_TRACE: tracePath, JITI_FS_CACHE: "0" });
	const started = performance.now();
	const result = await loadExtensions(paths, process.env.HOME);
	elapsedMs = performance.now() - started;
	assert.deepEqual(result.errors, []);
	assert.deepEqual(
		result.extensions.flatMap((extension) => [...extension.tools.keys()]),
		names,
	);
	assert.deepEqual(
		[...result.runtime.flagValues],
		names.map((name) => [`${name}-flag`, name]),
	);
	commands = result.extensions.flatMap((extension) =>
		[...extension.commands.values()].map((command) => ({ name: command.name, description: command.description })),
	);
} else {
	const hook = new URL("../source-hook.mjs", import.meta.url).pathname;
	const cliArgs = [
		"--mode",
		"rpc",
		"--no-session",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		...paths.flatMap((path) => ["--extension", path]),
	];
	const args =
		mode === "embedded"
			? cliArgs
			: [
					"--import",
					hook,
					...(diagnostic ? ["--cpu-prof", `--cpu-prof-dir=${evidence}`] : []),
					join(root, "packages/coding-agent", mode === "bundled" ? "dist/bundle/cli.js" : "dist/cli.js"),
					...cliArgs,
				];
	writeFileSync(
		join(evidence, "command.json"),
		`${JSON.stringify({ executable: mode === "embedded" ? embedded : process.execPath, args, cwd: process.env.HOME, env }, null, 2)}\n`,
	);
	for (const stream of ["stdout", "stderr"]) writeFileSync(join(evidence, `rpc.${stream}.jsonl`), "", { flag: "wx" });
	const started = performance.now();
	const child = spawn(mode === "embedded" ? embedded : process.execPath, args, {
		cwd: process.env.HOME,
		env,
		stdio: ["pipe", "pipe", "pipe"],
	});
	let pending = "";
	let failure;
	const deadline = setTimeout(() => {
		failure = "RPC startup deadline exceeded";
		child.kill("SIGTERM");
	}, 30_000);
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
		appendFileSync(join(evidence, "rpc.stdout.jsonl"), chunk);
		pending += chunk;
		for (;;) {
			const newline = pending.indexOf("\n");
			if (newline < 0) break;
			const line = pending.slice(0, newline);
			pending = pending.slice(newline + 1);
			if (!line.trim() || (diagnostic && !line.startsWith("{"))) continue;
			try {
				const response = JSON.parse(line);
				responses.push(response);
				if (response.id === "ready") {
					assert.equal(response.success, true);
					assert.equal(response.command, "get_commands");
					commands = response.data.commands
						.filter((command) => names.includes(command.name))
						.map(({ name, description }) => ({ name, description }));
					elapsedMs = performance.now() - started;
					child.stdin.end();
				}
			} catch (error) {
				failure = String(error);
				child.stdin.end();
			}
		}
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
		appendFileSync(join(evidence, "rpc.stderr.jsonl"), chunk);
	});
	child.stdin.on("error", (error) => {
		failure = String(error);
	});
	const closed = new Promise((done, fail) => {
		child.once("error", fail);
		child.once("close", (code, signal) => done({ code, signal }));
	});
	child.stdin.write(
		`${JSON.stringify({ id: "state", type: "get_state" })}\n${JSON.stringify({ id: "ready", type: "get_commands" })}\n`,
	);
	const status = await closed.finally(() => clearTimeout(deadline));
	assert.equal(status.code, 0, JSON.stringify({ status, failure, stderr }));
	assert.equal(failure, undefined);
	assert.equal(pending, "", "RPC emitted an unterminated line");
	assert.deepEqual(
		responses
			.filter((response) => response.type === "response")
			.map(({ id, command, success }) => ({ id, command, success })),
		[
			{ id: "state", command: "get_state", success: true },
			{ id: "ready", command: "get_commands", success: true },
		],
	);
	const state = responses.find((response) => response.id === "state").data;
	assert.equal(state.messageCount, 0);
	assert.equal(state.pendingMessageCount, 0);
}
assert.deepEqual(
	commands,
	names.map((name, i) => ({ name, description: descriptions[i] })),
);
assert.ok(Number.isFinite(elapsedMs));
const trace = readFileSync(tracePath, "utf8")
	.trim()
	.split("\n")
	.map((line) => JSON.parse(line));
for (const type of ["import:start", "import:end"])
	assert.deepEqual(
		trace
			.filter((event) => event.type === type)
			.map((event) => event.name)
			.sort(),
		[...names].sort(),
	);
assert.deepEqual(
	trace.filter((event) => event.type.startsWith("factory:")).map((event) => `${event.type}:${event.name}`),
	names.flatMap((name) => [`factory:start:${name}`, `factory:end:${name}`]),
);
const dependencies = trace
	.filter((event) => event.type === "dependency")
	.map((event) => event.name)
	.sort();
assert.deepEqual(
	dependencies,
	workload === "esm"
		? [
				"shared/labels",
				"shared/format",
				...names.flatMap((name) => [`${name}/values`, `${name}/schema`, `${name}/metadata`]),
			].sort()
		: [],
);
if (diagnostic) {
	const debug = `${stdout}\n${stderr}`.replace(/\u001b\[[0-9;]*m/g, "");
	for (const path of paths) {
		assert.ok(
			debug
				.split("\n")
				.some((line) => line.includes(path) && line.includes(workload === "esm" ? "[native]" : "[transpile]")),
			`missing ${workload} route witness for ${path}`,
		);
	}
	if (workload === "esm")
		assert.ok(
			!debug.split("\n").some((line) => line.includes(fixture) && /\[(fallback|transpile)\]/.test(line)),
			"compiled ESM fell back to transformation",
		);
	console.log(
		JSON.stringify({
			diagnostic: {
				workload,
				mode,
				route: workload === "esm" ? "native" : "transpile",
				entries: paths.length,
				comparativeTiming: false,
			},
		}),
	);
}
const output = {
	commands,
	imports: names.length,
	factories: names.length,
	dependencies,
	errors: 0,
	rpcResponses: responses
		.filter((response) => response.type === "response")
		.map(({ command, success }) => ({ command, success })),
};
witness(`extension-imports-${workload}-${mode}`, { workload, compilerVersion, files }, output);
console.log(JSON.stringify({ metric: "extension-imports", workload, mode, diagnostic, elapsedMs, ...output }));
