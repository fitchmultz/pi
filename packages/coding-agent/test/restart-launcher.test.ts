import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { transformSync } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { getCliWorkerPath, superviseCli } from "../src/cli/launcher.ts";
import {
	parseRestartCommand,
	parseRestartRequest,
	type RestartCheckpoint,
	type RestartHandoff,
} from "../src/cli/restart-protocol.ts";
import { getRestartArgs } from "../src/cli/restart-worker.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { resolveCliModel } from "../src/core/model-resolver.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const directories: string[] = [];
const children: ChildProcess[] = [];
const workerPids: number[] = [];
afterEach(() => {
	for (const child of children.splice(0))
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	for (const pid of workerPids.splice(0)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
	for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(
	candidateBody: string,
	fallbackBody = "process.send({ type: 'pi:ready' }, () => process.exit(0));",
	options: { model?: RestartCheckpoint["model"]; args?: string[] } = {},
) {
	const root = mkdtempSync(join(tmpdir(), "pi-supervisor-test-"));
	directories.push(root);
	const trace = join(root, "trace.jsonl");
	const runtime = join(root, "candidate");
	mkdirSync(join(runtime, "dist", "bundle"), { recursive: true });
	const checkpoint: RestartCheckpoint = {
		sessionFile: join(root, "session.jsonl"),
		sessionId: "same-session",
		cwd: root,
		leafId: "saved-leaf",
		model: options.model ?? { provider: "faux", id: "faux-1" },
		thinkingLevel: "off",
		activeTools: ["bash"],
		knownTools: ["bash", "read"],
	};
	const log = (name: string) => `
import { appendFileSync } from 'node:fs';
const handoff = process.env.PI_RESTART_HANDOFF ? JSON.parse(process.env.PI_RESTART_HANDOFF) : undefined;
appendFileSync(${JSON.stringify(trace)}, JSON.stringify({name:${JSON.stringify(name)}, pid:process.pid, args:process.argv.slice(2), handoff, socket:process.env.PI_RESTART_SOCKET}) + '\\n');
`;
	const worker = join(root, "working.mjs");
	const toolConfiguration = { allowedToolNames: [], excludedToolNames: ["blocked"], noBuiltinTools: true };
	const restart = {
		type: "pi:restart",
		toolConfiguration,
		request: { runtime, extensions: [join(root, "v2.ts")], message: "Check the new capability" },
		checkpoint,
		args: options.args ?? ["-ne", "--custom-flag", "keep this value"],
		extensions: [join(root, "v1.ts")],
	};
	writeFileSync(
		worker,
		`${log("working")}
if (!handoff) {
	process.send({type:'pi:ready'}, () => process.send(${JSON.stringify(restart)}, () => process.exit(0)));
} else { ${fallbackBody} }
`,
	);
	writeFileSync(join(runtime, "dist", "bundle", "cli-worker.js"), `${log("candidate")}\n${candidateBody}`);
	return {
		worker,
		checkpoint,
		toolConfiguration,
		read: () =>
			readFileSync(trace, "utf8")
				.trim()
				.split("\n")
				.map(
					(line) =>
						JSON.parse(line) as {
							name: string;
							pid: number;
							args: string[];
							socket?: string;
							handoff?: RestartHandoff;
						},
				),
	};
}

const cleanEnv = {
	PATH: process.env.PATH,
	SystemRoot: process.env.SystemRoot,
	PI_RESTART_SOCKET: "outer-session-endpoint",
};

function selectorFixture(managed = false) {
	const root = mkdtempSync(join(tmpdir(), "pi-restart-selector-"));
	directories.push(root);
	const trace = join(root, "trace.jsonl");
	const managedRoot = join(root, "managed");
	const selector = managed ? join(managedRoot, "current-version") : join(root, "selected");
	const packagePath = (name: string) =>
		managed
			? join(managedRoot, "releases", name, "node_modules", "@earendil-works", "pi-coding-agent")
			: join(root, "releases", name);
	const launcherModule = pathToFileURL(resolve(__dirname, "../src/cli/launcher.ts")).href;
	const launcherSource = transformSync(
		readFileSync(resolve(__dirname, "../src/cli-launcher.ts"), "utf8").replace(
			'from "./cli/launcher.ts"',
			`from ${JSON.stringify(launcherModule)}`,
		),
		{ loader: "ts", format: "esm" },
	).code;
	const checkpoint: RestartCheckpoint = {
		sessionFile: join(root, "session.jsonl"),
		sessionId: "selector-session",
		cwd: root,
		leafId: "selected-leaf",
		model: { provider: "faux", id: "faux-1" },
		thinkingLevel: "off",
		activeTools: ["bash"],
		knownTools: ["bash"],
	};
	if (managed) {
		mkdirSync(managedRoot, { recursive: true });
		writeFileSync(
			join(managedRoot, "managed-install.json"),
			JSON.stringify({ kind: "pi-managed-install", schemaVersion: 1, layout: "releases-v1" }),
		);
	} else {
		const bin = join(root, "bin");
		mkdirSync(bin);
		symlinkSync("../selected/dist/bundle/cli.js", join(bin, "pi"));
	}
	return {
		root,
		trace,
		selector,
		checkpoint,
		packagePath,
		release(name: string, version: string, body: string, source = false) {
			const directory = source ? join(root, "source", name) : packagePath(name);
			const subdir = source ? "src" : "dist/bundle";
			const entry = join(directory, subdir, source ? "cli-launcher.ts" : "cli.js");
			const worker = join(directory, subdir, source ? "cli.ts" : "cli-worker.js");
			mkdirSync(dirname(entry), { recursive: true });
			writeFileSync(join(directory, "package.json"), JSON.stringify({ type: "module", version }));
			writeFileSync(entry, launcherSource);
			chmodSync(entry, 0o755);
			writeFileSync(
				worker,
				`
import { appendFileSync, existsSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const loaded = fileURLToPath(import.meta.url);
const packageDir = ${source ? "dirname(dirname(loaded))" : "dirname(dirname(dirname(loaded)))"};
const handoff = process.env.PI_RESTART_HANDOFF ? JSON.parse(process.env.PI_RESTART_HANDOFF) : undefined;
appendFileSync(${JSON.stringify(trace)}, JSON.stringify({
	name: ${JSON.stringify(name)}, pid: process.pid, loaded, packageDir,
	version: JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).version,
	args: process.argv.slice(2), handoff, socket: process.env.PI_RESTART_SOCKET
}) + "\\n");
const select = (name) => {
	const temporary = ${JSON.stringify(selector)} + ".tmp." + process.pid;
	${managed ? `writeFileSync(temporary, name + "\\n");` : `symlinkSync(${JSON.stringify(join(root, "releases"))} + "/" + name, temporary);`}
	renameSync(temporary, ${JSON.stringify(selector)});
};
const readyExit = () => process.send({ type: "pi:ready" }, () => process.exit(0));
const restart = (request = {}, extensions = [${JSON.stringify(join(root, "old.ts"))}]) =>
	process.send({ type: "pi:ready" }, () => process.send({
		type: "pi:restart", request: { message: "Resume work", ...request },
		checkpoint: ${JSON.stringify(checkpoint)}, args: ["-ne"], extensions
	}, () => process.exit(0)));
${body}
`,
			);
			if (managed && !source) {
				const bin = join(managedRoot, "releases", name, "node_modules", ".bin");
				mkdirSync(bin, { recursive: true });
				symlinkSync("../@earendil-works/pi-coding-agent/dist/bundle/cli.js", join(bin, "pi"));
			}
			return { directory, entry, worker };
		},
		select(name: string) {
			const temporary = `${selector}.tmp`;
			if (managed) writeFileSync(temporary, `${name}\n`);
			else symlinkSync(packagePath(name), temporary);
			renameSync(temporary, selector);
		},
		run(
			entry = managed
				? join(managedRoot, "releases", "1.0.0", "node_modules", ".bin", "pi")
				: join(root, "bin", "pi"),
		) {
			const result = spawnSync(entry, ["original task", "@original.md"], {
				env: { ...cleanEnv, ...(managed ? { PI_MANAGED_INSTALL_ROOT: managedRoot } : {}) },
				encoding: "utf8",
				timeout: 12_000,
			});
			expect(result.error).toBeUndefined();
			expect(result.status, result.stderr).toBe(0);
			return readFileSync(trace, "utf8")
				.trim()
				.split("\n")
				.map(
					(line) =>
						JSON.parse(line) as {
							name: string;
							pid: number;
							loaded: string;
							packageDir: string;
							version: string;
							args: string[];
							handoff?: RestartHandoff;
							socket?: string;
						},
				);
		},
	};
}

describe("restart arguments and validation", () => {
	it("captures only persistent options with the real CLI parser", () => {
		expect(
			getRestartArgs([
				"-ne",
				"-ns",
				"-np",
				"-nc",
				"-e",
				"./old.ts",
				"--session",
				"old.jsonl",
				"--session-dir",
				"/custom/sessions",
				"--name",
				"old name",
				"--model",
				"old/model",
				"--thinking",
				"high",
				"--fork",
				"another.jsonl",
				"-a",
				"--custom-flag",
				"an extension value",
				"--toggle",
				"--inline=value",
				"@old-file.md",
				"original task",
				"--",
				"--not-a-flag",
				"@another.md",
			]),
		).toEqual([
			"-ne",
			"-ns",
			"-np",
			"-nc",
			"--session-dir",
			"/custom/sessions",
			"-a",
			"--custom-flag",
			"an extension value",
			"--toggle",
			"--inline=value",
		]);
	});

	it("does not forward a CLI API key unless its original provider is still selected", () => {
		const args = ["--model", "provider/model", "--api-key", "test-only-key", "-ne"];
		expect(getRestartArgs(args)).toEqual(["-ne"]);
		expect(getRestartArgs(args, true)).toEqual(["--api-key", "test-only-key", "-ne"]);
		expect(getRestartArgs(["--no-approve", "-ne"])).toEqual(["--no-approve", "-ne"]);
	});

	it("resolves staged resources without executing shell text", () => {
		const cwd = process.cwd();
		expect(
			parseRestartCommand(
				["--message", "continue; $(not-a-command)", "--runtime", "next", "-e", "tools.ts", "-e", "other.ts"],
				cwd,
			),
		).toEqual({
			message: "continue; $(not-a-command)",
			runtime: join(cwd, "next"),
			extensions: [join(cwd, "tools.ts"), join(cwd, "other.ts")],
		});
		expect(parseRestartCommand([], cwd)).toEqual({});
		expect(() => parseRestartCommand(["--message"], cwd)).toThrow("Missing value");
		expect(() => parseRestartCommand(["--bogus", "yes"], cwd)).toThrow("Unknown restart option");
	});

	it.each([
		null,
		[],
		{ runtime: "relative" },
		{ message: 42 },
		{ message: "x".repeat(8193) },
		{ extensions: ["relative"] },
		{ extensions: [42] },
		{ unexpected: true },
	])("rejects invalid local control messages: %j", (input) => {
		expect(() => parseRestartRequest(input)).toThrow();
	});

	it("locates bundled, unbundled and source workers", () => {
		const root = join(process.cwd(), "package");
		expect(getCliWorkerPath(join(root, "dist", "bundle", "cli.js"))).toBe(
			join(root, "dist", "bundle", "cli-worker.js"),
		);
		expect(getCliWorkerPath(join(root, "dist", "cli-launcher.js"))).toBe(join(root, "dist", "cli.js"));
		expect(getCliWorkerPath(join(root, "src", "cli-launcher.ts"))).toBe(join(root, "src", "cli.ts"));
	});
});

describe.skipIf(process.platform === "win32")("selected installation restarts", () => {
	it("follows the original CLI symlink through A, B, then C with equal-version releases", () => {
		const f = selectorFixture();
		f.release("A", "1.0.0", 'if (!handoff) { select("B"); restart(); } else readyExit();');
		const b = f.release("B", "2.0.0", 'select("C"); restart();');
		const c = f.release("C", "2.0.0", "readyExit();");
		f.select("A");
		const trace = f.run();
		expect(trace.map((entry) => entry.name)).toEqual(["A", "B", "C"]);
		expect(trace.map((entry) => entry.packageDir)).toEqual(
			[f.packagePath("A"), b.directory, c.directory].map((directory) => realpathSync(directory)),
		);
		expect(trace.map((entry) => entry.version)).toEqual(["1.0.0", "2.0.0", "2.0.0"]);
		expect(new Set(trace.map((entry) => entry.pid)).size).toBe(3);
		expect(trace[1].handoff?.checkpoint).toEqual(f.checkpoint);
		expect(trace[2].handoff?.checkpoint).toEqual(f.checkpoint);
		expect(trace.every((entry) => entry.socket === undefined)).toBe(true);
		expect(trace.slice(1).every((entry) => !entry.args.includes("original task"))).toBe(true);
	});

	it.each(["1.0.0", "2.0.0"])(
		"follows the managed selector from an owned release bin (initial selection: %s)",
		(initialSelection) => {
			const f = selectorFixture(true);
			f.release("1.0.0", "1.0.0", 'select("2.0.0"); restart();');
			f.release("2.0.0", "2.0.0", 'select("3.0.0"); restart();');
			f.release("3.0.0", "3.0.0", "readyExit();");
			f.select(initialSelection);
			// An older release's .bin/pi with the inherited managed root is also an installation entrypoint.
			const trace = f.run();
			expect(trace.map((entry) => entry.version)).toEqual(["1.0.0", "2.0.0", "3.0.0"]);
			expect(trace.map((entry) => entry.packageDir)).toEqual(
				["1.0.0", "2.0.0", "3.0.0"].map((version) => realpathSync(f.packagePath(version))),
			);
			expect(new Set(trace.map((entry) => entry.pid)).size).toBe(3);
		},
	);

	it.each(["direct release", "source checkout"])(
		"keeps a %s on its own runtime despite an inherited managed root",
		(kind) => {
			const f = selectorFixture(true);
			const body = 'if (!handoff) { select("2.0.0"); restart(); } else readyExit();';
			const direct = f.release("1.0.0", "1.0.0", body);
			const source = f.release("checkout", "source", body, true);
			f.release("2.0.0", "2.0.0", "readyExit();");
			f.select("1.0.0");
			const selected = kind === "source checkout" ? source : direct;
			const trace = f.run(selected.entry);
			expect(trace.map((entry) => entry.packageDir)).toEqual([
				realpathSync(selected.directory),
				realpathSync(selected.directory),
			]);
			expect(trace[1].pid).not.toBe(trace[0].pid);
			expect(readFileSync(f.selector, "utf8")).toBe("2.0.0\n");
		},
	);

	it("keeps an explicit --runtime worker after a later ordinary restart moves the original selector", () => {
		const f = selectorFixture();
		const b = f.packagePath("B");
		const marker = join(f.root, "b-restarted");
		f.release("A", "1.0.0", `select("C"); restart({ runtime: ${JSON.stringify(b)} });`);
		f.release(
			"B",
			"2.0.0",
			`if (!existsSync(${JSON.stringify(marker)})) { writeFileSync(${JSON.stringify(marker)}, ""); restart(); } else readyExit();`,
		);
		f.release("C", "3.0.0", "readyExit();");
		f.select("A");
		const trace = f.run();
		expect(trace.map((entry) => entry.name)).toEqual(["A", "B", "B"]);
		expect(trace[2].packageDir).toBe(realpathSync(b));
		expect(new Set(trace.map((entry) => entry.pid)).size).toBe(3);
	});

	it("rolls back to the exact previous worker and extensions after a failed selected update", () => {
		const f = selectorFixture();
		f.release("A", "1.0.0", 'if (!handoff) { select("B"); restart({ extensions: ["/new.ts"] }); } else restart();');
		f.release("B", "2.0.0", 'select("C"); process.exit(17);');
		f.release("C", "3.0.0", "readyExit();");
		f.select("A");
		const trace = f.run();
		expect(trace.map((entry) => entry.name)).toEqual(["A", "B", "A", "C"]);
		expect(trace[1].args.at(-1)).toBe("/new.ts");
		expect(trace[2].args.at(-1)).toBe(join(f.root, "old.ts"));
		expect(trace[3].args.at(-1)).toBe(join(f.root, "old.ts"));
		expect(trace[2].handoff?.failure).toBe("Updated Pi failed during startup.");
		expect(trace[2].loaded).toBe(trace[0].loaded);
		expect(trace[3].packageDir).toBe(realpathSync(f.packagePath("C")));
	});

	it("recovers the old explicit selection when a later explicit candidate fails", () => {
		const f = selectorFixture();
		const b = f.packagePath("B");
		const c = f.packagePath("C");
		const marker = join(f.root, "b-recovered");
		f.release("A", "1.0.0", `restart({ runtime: ${JSON.stringify(b)} });`);
		f.release(
			"B",
			"2.0.0",
			`if (existsSync(${JSON.stringify(marker)})) readyExit();
else if (!handoff?.failure) restart({ runtime: ${JSON.stringify(c)}, extensions: ["/new.ts"] });
else { writeFileSync(${JSON.stringify(marker)}, ""); restart(); }`,
		);
		f.release("C", "3.0.0", 'select("D"); process.exit(17);');
		f.release("D", "4.0.0", "readyExit();");
		f.select("A");
		const trace = f.run();
		expect(trace.map((entry) => entry.name)).toEqual(["A", "B", "C", "B", "B"]);
		expect(trace[2].args.at(-1)).toBe("/new.ts");
		expect(trace[3].args.at(-1)).toBe(join(f.root, "old.ts"));
		expect(trace[4].packageDir).toBe(realpathSync(b));
		expect(realpathSync(f.selector)).toBe(realpathSync(f.packagePath("D")));
	});

	it("reuses the previous worker when the newly selected release is missing", () => {
		const f = selectorFixture();
		f.release("A", "1.0.0", 'if (!handoff) { select("missing"); restart(); } else readyExit();');
		f.select("A");
		const trace = f.run();
		expect(trace.map((entry) => entry.name)).toEqual(["A", "A"]);
		expect(trace[1].handoff?.failure).toContain("Could not select the updated runtime");
		expect(trace[1].args.at(-1)).toBe(join(f.root, "old.ts"));
	});
});

describe("real-process restart supervisor", () => {
	it.skipIf(process.platform === "win32").each(["SIGTERM", "SIGKILL"] as const)(
		"does not leave a worker or restart after launcher %s",
		async (signal) => {
			const root = mkdtempSync(join(tmpdir(), "pi-supervisor-signal-"));
			directories.push(root);
			const pidFile = join(root, "worker-pid");
			const cleaned = join(root, "worker-cleaned");
			const worker = join(root, "worker.mjs");
			const parent = join(root, "parent.mjs");
			const workerModule = pathToFileURL(resolve(__dirname, "../src/cli/restart-worker.ts")).href;
			const launcherModule = pathToFileURL(resolve(__dirname, "../src/cli/launcher.ts")).href;
			writeFileSync(
				worker,
				`
import {writeFileSync} from 'node:fs';
import {createManagedRestart} from ${JSON.stringify(workerModule)};
createManagedRestart([]);
process.on('SIGTERM', () => { writeFileSync(${JSON.stringify(cleaned)}, 'cleaned'); process.exit(0); });
process.send({type:'pi:ready'});
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);
`,
			);
			writeFileSync(
				parent,
				`import {superviseCli} from ${JSON.stringify(launcherModule)}; process.exitCode = await superviseCli(${JSON.stringify(worker)}, [], {execArgv:[]});`,
			);
			const child = spawn(process.execPath, [parent], { env: cleanEnv, stdio: "ignore" });
			children.push(child);
			const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveResult, reject) => {
				child.once("error", reject);
				child.once("exit", (code, exitSignal) => resolveResult({ code, signal: exitSignal }));
			});
			await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true));
			const workerPid = Number(readFileSync(pidFile, "utf8"));
			workerPids.push(workerPid);
			child.kill(signal);
			const result = await exited;
			if (signal === "SIGTERM") expect(result.code).toBe(143);
			else expect(result.signal).toBe("SIGKILL");
			await vi.waitFor(() => expect(existsSync(cleaned)).toBe(true));
			await vi.waitFor(() => expect(() => process.kill(workerPid, 0)).toThrow());
		},
	);
	it("changes workers and explicit extensions, preserving the exact checkpoint without replaying startup input", async () => {
		const f = fixture("process.send({ type: 'pi:ready' }, () => process.exit(0));");
		expect(await superviseCli(f.worker, ["original task", "@original.md"], { env: cleanEnv, execArgv: [] })).toBe(0);
		const trace = f.read();
		expect(trace.map((entry) => entry.name)).toEqual(["working", "candidate"]);
		expect(trace[0].pid).not.toBe(trace[1].pid);
		expect(trace[1].handoff?.checkpoint).toEqual(f.checkpoint);
		expect(trace[1].handoff?.toolConfiguration).toEqual(f.toolConfiguration);
		expect(trace[1].handoff?.message).toBe("Check the new capability");
		expect(trace[1].args).toContain(f.checkpoint.sessionFile);
		expect(trace[1].args).toContain("faux/faux-1");
		expect(trace[1].args).not.toContain("--approve");
		expect(trace[1].args).not.toContain("--no-approve");
		expect(trace[1].args).not.toContain("original task");
		expect(trace[1].args).not.toContain("@original.md");
		expect(trace[1].args.at(-1)).toMatch(/v2\.ts$/);
		expect(trace.every((entry) => entry.socket === undefined)).toBe(true);
	});

	// PR #29: an authenticated raw ID must not redirect a retained CLI key to another provider.
	it.each([false, true])(
		"preserves the checkpoint provider despite a raw-ID collision (rollback: %s)",
		async (rollback) => {
			vi.stubEnv("XIAOMI_API_KEY", undefined);
			const modelRuntime = await ModelRuntime.create({
				credentials: AuthStorage.inMemory({ commandcode: { type: "api_key", key: "commandcode-key" } }),
				modelsPath: null,
				allowModelNetwork: false,
			});
			const xiaomi = modelRuntime.getModel("xiaomi", "mimo-v2.5-pro")!;
			modelRuntime.registerProvider("commandcode", {
				api: xiaomi.api,
				baseUrl: "https://example.invalid",
				models: [{ ...xiaomi, id: "xiaomi/mimo-v2.5-pro", baseUrl: "https://example.invalid" }],
			});
			await modelRuntime.refresh({ allowNetwork: false });
			expect(modelRuntime.hasConfiguredAuth("xiaomi")).toBe(false);
			expect(resolveCliModel({ cliModel: "xiaomi/mimo-v2.5-pro", modelRuntime }).model?.provider).toBe(
				"commandcode",
			);
			const original = ["--provider", "xiaomi", "--model", "mimo-v2.5-pro", "--api-key", "test-only-key", "-ne"];
			const initial = parseArgs(original);
			expect(
				resolveCliModel({ cliProvider: initial.provider, cliModel: initial.model, modelRuntime }).model,
			).toEqual(xiaomi);
			const f = fixture(
				rollback ? "process.exit(17);" : "process.send({ type: 'pi:ready' }, () => process.exit(0));",
				undefined,
				{
					model: { provider: xiaomi.provider, id: xiaomi.id },
					args: getRestartArgs(original, true),
				},
			);
			expect(await superviseCli(f.worker, original, { env: cleanEnv, execArgv: [] })).toBe(0);
			const resumed = parseArgs(f.read().at(-1)!.args);
			const resolved = resolveCliModel({
				cliProvider: resumed.provider,
				cliModel: resumed.model,
				cliThinking: resumed.thinking,
				modelRuntime,
			});
			expect(resumed.apiKey).toBe("test-only-key");
			expect(resolved.error).toBeUndefined();
			expect(resolved.model).toEqual(xiaomi);
			await modelRuntime.setRuntimeApiKey(resolved.model!.provider, resumed.apiKey!);
			expect((await modelRuntime.getAuth("xiaomi"))?.auth.apiKey).toBe("test-only-key");
			expect((await modelRuntime.getAuth("commandcode"))?.auth.apiKey).toBe("commandcode-key");
		},
	);

	it("rolls back failed startup to the prior runtime and extension list, with no lost continuation", async () => {
		const f = fixture("process.exit(17);");
		expect(await superviseCli(f.worker, ["original task"], { env: cleanEnv, execArgv: [] })).toBe(0);
		const trace = f.read();
		expect(trace.map((entry) => entry.name)).toEqual(["working", "candidate", "working"]);
		expect(trace[2].handoff).toMatchObject({
			checkpoint: f.checkpoint,
			toolConfiguration: f.toolConfiguration,
			message: "Check the new capability",
			failure: "Updated Pi failed during startup.",
		});
		expect(trace[2].args.at(-1)).toMatch(/v1\.ts$/);
		expect(trace[2].args).not.toContain("original task");
	});

	it("bounds rollback when the previous runtime also fails", async () => {
		const f = fixture("process.exit(17);", "process.exit(23);");
		expect(await superviseCli(f.worker, [], { env: cleanEnv, execArgv: [] })).toBe(23);
		expect(f.read().map((entry) => entry.name)).toEqual(["working", "candidate", "working"]);
	});

	it("recovers from a startup hang", async () => {
		const f = fixture("setInterval(() => {}, 1000);");
		expect(await superviseCli(f.worker, [], { env: cleanEnv, execArgv: [], startupTimeoutMs: 500 })).toBe(0);
		expect(f.read().at(-1)?.handoff?.failure).toContain("startup deadline");
	});

	it("does not treat normal quit before readiness as a failed update", async () => {
		const f = fixture("process.exit(0);");
		expect(await superviseCli(f.worker, [], { env: cleanEnv, execArgv: [] })).toBe(0);
		expect(f.read()).toHaveLength(2);
	});

	it("does not replay work after a ready worker later crashes", async () => {
		const f = fixture("process.send({ type: 'pi:ready' }, () => process.exit(17));");
		expect(await superviseCli(f.worker, [], { env: cleanEnv, execArgv: [] })).toBe(17);
		expect(f.read()).toHaveLength(2);
	});
});
