import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { getDefaultSessionDir } from "../src/core/session-manager.ts";

// Run the same startup contract against source or a separately built CLI.
const cliArgs = process.env.PI_TEST_CLI
	? [process.env.PI_TEST_CLI]
	: ["--import", resolve(__dirname, "../src/experimental/source-resolver.ts"), resolve(__dirname, "../src/cli.ts")];
const tempDirs: string[] = [];
const sessionId = "01234567-89ab-4cde-8012-3456789abcde";

function setup(defaultStorage = false) {
	// Match process.cwd() on platforms where the temp directory is a symlink.
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-startup-session-cwd-")));
	tempDirs.push(root);
	const home = join(root, "home");
	const agentDir = join(home, "agent");
	const originalCwd = join(root, "original");
	const launchCwd = join(home, "launch");
	const sessionDir = defaultStorage ? getDefaultSessionDir(originalCwd, agentDir) : join(root, "sessions");
	const temp = join(root, "tmp");
	for (const dir of [agentDir, originalCwd, launchCwd, sessionDir, temp]) mkdirSync(dir, { recursive: true });
	const sessionFile = join(sessionDir, "fixture.jsonl");
	const timestamp = "2026-01-01T00:00:00.000Z";
	const header = { type: "session", version: 3, id: sessionId, timestamp, cwd: originalCwd };
	const entries = [
		{ type: "model_change", id: "model", parentId: null, timestamp, provider: "faux", modelId: "faux-1" },
		{ type: "thinking_level_change", id: "thinking", parentId: "model", timestamp, thinkingLevel: "off" },
		{
			type: "message",
			id: "user",
			parentId: "thinking",
			timestamp,
			message: { role: "user", content: "Synthetic saved history", timestamp: 0 },
		},
		{ type: "custom", id: "state", parentId: "user", timestamp, customType: "fixture", data: { retained: true } },
	];
	const bytes = `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
	writeFileSync(sessionFile, bytes);
	const marker = join(root, "extension-loaded");
	const snapshot = join(root, "snapshot.json");
	const shutdown = join(root, "shutdown.json");
	const extension = join(root, "fixture.ts");
	writeFileSync(
		extension,
		`
import { writeFileSync } from "node:fs";
import { fauxProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function (pi: ExtensionAPI) {
	writeFileSync(${JSON.stringify(marker)}, "loaded");
	// No cwd override here: this observes the native cwd bound before the factory ran.
	const executed = await pi.exec(process.execPath, ["-p", "process.cwd()"]);
	const faux = fauxProvider();
	pi.registerProvider("faux", {
		api: faux.api,
		baseUrl: faux.getModel().baseUrl,
		apiKey: "faux-key",
		models: faux.models,
		streamSimple: faux.provider.streamSimple,
	});
	pi.on("session_start", (_event, ctx) => {
		writeFileSync(${JSON.stringify(snapshot)}, JSON.stringify({
			executed,
			cwd: ctx.cwd,
			sessionCwd: ctx.sessionManager.getCwd(),
			sessionId: ctx.sessionManager.getSessionId(),
			sessionFile: ctx.sessionManager.getSessionFile(),
			header: ctx.sessionManager.getHeader(),
			entries: ctx.sessionManager.getEntries(),
			model: { provider: ctx.model?.provider, id: ctx.model?.id },
			thinkingLevel: pi.getThinkingLevel(),
		}));
	});
	pi.on("session_shutdown", () => {
		writeFileSync(${JSON.stringify(shutdown)}, JSON.stringify({ providerCalls: faux.state.callCount }));
	});
}
`,
	);
	return {
		root,
		home,
		agentDir,
		originalCwd,
		launchCwd,
		sessionDir,
		sessionFile,
		temp,
		header,
		entries,
		bytes,
		marker,
		snapshot,
		shutdown,
		extension,
	};
}

type Fixture = ReturnType<typeof setup>;

async function runCli(fixture: Fixture, args: string[], input?: string) {
	for (const file of [fixture.marker, fixture.snapshot, fixture.shutdown]) rmSync(file, { force: true });
	let stdout = "";
	let stderr = "";
	const child = spawn(
		process.execPath,
		[
			...cliArgs,
			"--offline",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
			"--no-approve",
			"--extension",
			fixture.extension,
			"--print",
			...args,
		],
		{
			cwd: fixture.launchCwd,
			env: {
				PATH: process.env.PATH,
				SystemRoot: process.env.SystemRoot,
				HOME: fixture.home,
				USERPROFILE: fixture.home,
				[ENV_AGENT_DIR]: fixture.agentDir,
				XDG_CONFIG_HOME: join(fixture.home, "config"),
				XDG_CACHE_HOME: join(fixture.home, "cache"),
				XDG_DATA_HOME: join(fixture.home, "data"),
				XDG_STATE_HOME: join(fixture.home, "state"),
				XDG_RUNTIME_DIR: fixture.temp,
				TMPDIR: fixture.temp,
				TMP: fixture.temp,
				TEMP: fixture.temp,
				npm_config_userconfig: join(fixture.home, "user.npmrc"),
				npm_config_globalconfig: join(fixture.home, "global.npmrc"),
				npm_config_cache: join(fixture.home, "npm-cache"),
				PI_OFFLINE: "1",
				PI_TELEMETRY: "0",
				NO_COLOR: "1",
			},
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	child.stdin.end(input);
	child.stdout.on("data", (chunk) => {
		stdout += chunk.toString();
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>(
		(resolvePromise, reject) => {
			child.on("error", reject);
			child.on("close", (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
		},
	);
}

function expectSelected(fixture: Fixture, result: Awaited<ReturnType<typeof runCli>>, cwd: string) {
	expect(result, result.stderr).toMatchObject({ code: 0, signal: null, stderr: "" });
	expect(JSON.parse(readFileSync(fixture.snapshot, "utf8"))).toEqual({
		executed: { stdout: `${cwd}\n`, stderr: "", code: 0, killed: false },
		cwd,
		sessionCwd: cwd,
		sessionId,
		sessionFile: fixture.sessionFile,
		header: fixture.header,
		entries: fixture.entries,
		model: { provider: "faux", id: "faux-1" },
		thinkingLevel: "off",
	});
	expect(JSON.parse(readFileSync(fixture.shutdown, "utf8"))).toEqual({ providerCalls: 0 });
	expect(readFileSync(fixture.sessionFile, "utf8")).toBe(fixture.bytes);
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("startup --session-cwd", () => {
	it("selects the override before extension loading without changing saved identity or history on repeat opens", async () => {
		const fixture = setup();
		rmdirSync(fixture.originalCwd);
		for (let i = 0; i < 2; i++) {
			const result = await runCli(fixture, ["--session", fixture.sessionFile, "--session-cwd", fixture.launchCwd]);
			expectSelected(fixture, result, fixture.launchCwd);
		}
	});

	it("keeps the missing stored-cwd error without an override", async () => {
		const fixture = setup();
		rmdirSync(fixture.originalCwd);
		const result = await runCli(fixture, ["--session", fixture.sessionFile]);
		expect(result).toMatchObject({ code: 1, signal: null });
		expect(result.stderr).toContain(`Stored session working directory does not exist: ${fixture.originalCwd}`);
		expect(result.stderr).toContain(`Current working directory: ${fixture.launchCwd}`);
		expect(existsSync(fixture.marker)).toBe(false);
		expect(readFileSync(fixture.sessionFile, "utf8")).toBe(fixture.bytes);
	});

	it("resolves relative session and cwd paths from the launching directory", async () => {
		const fixture = setup();
		const target = join(fixture.home, "relative target");
		mkdirSync(target);
		rmdirSync(fixture.originalCwd);
		const result = await runCli(fixture, [
			"--session",
			relative(fixture.launchCwd, fixture.sessionFile),
			"--session-cwd",
			"../relative target",
		]);
		expectSelected(fixture, result, target);
	});

	it("expands tilde in the override using the native path resolver", async () => {
		const fixture = setup();
		const target = join(fixture.home, "tilde target");
		mkdirSync(target);
		rmdirSync(fixture.originalCwd);
		const result = await runCli(fixture, ["--session", fixture.sessionFile, "--session-cwd", "~/tilde target"]);
		expectSelected(fixture, result, target);
	});

	it("overrides a locally selected ID without using session storage as cwd", async () => {
		const fixture = setup();
		const result = await runCli({ ...fixture, launchCwd: fixture.originalCwd }, [
			"--session",
			sessionId.slice(0, 8),
			"--session-dir",
			fixture.sessionDir,
			"--session-cwd",
			fixture.launchCwd,
		]);
		expectSelected(fixture, result, fixture.launchCwd);
	});

	it.each([false, true])(
		"resumes a global ID directly with an override (default storage: %s)",
		async (defaultStorage) => {
			const fixture = setup(defaultStorage);
			rmdirSync(fixture.originalCwd);
			const result = await runCli(fixture, [
				"--session",
				sessionId.slice(0, 8),
				"--session-cwd",
				fixture.launchCwd,
				...(defaultStorage ? [] : ["--session-dir", fixture.sessionDir]),
			]);
			expect(result.stdout + result.stderr).not.toContain("Fork this session");
			expectSelected(fixture, result, fixture.launchCwd);
		},
	);

	it("keeps the global-ID fork confirmation when the override is omitted", async () => {
		const fixture = setup(true);
		const result = await runCli(fixture, ["--session", sessionId], "n\n");
		expect(result).toMatchObject({ code: 0, signal: null });
		expect(result.stderr).toContain("Fork this session into current directory?");
		expect(result.stderr).toContain("Aborted.");
		expect(existsSync(fixture.marker)).toBe(false);
		expect(readFileSync(fixture.sessionFile, "utf8")).toBe(fixture.bytes);
	});

	it.each(["missing", "file"])("rejects a %s override before loading extensions", async (kind) => {
		const fixture = setup();
		const target = kind === "file" ? fixture.sessionFile : join(fixture.root, "missing");
		const result = await runCli(fixture, ["--session", fixture.sessionFile, "--session-cwd", target]);
		expect(result).toMatchObject({ code: 1, signal: null });
		expect(result.stderr).toContain("Error: Invalid --session-cwd:");
		expect(result.stderr).toContain(target);
		expect(existsSync(fixture.marker)).toBe(false);
		expect(readFileSync(fixture.sessionFile, "utf8")).toBe(fixture.bytes);
	});

	it("requires an explicit --session", async () => {
		const fixture = setup();
		const result = await runCli(fixture, ["--session-cwd", fixture.launchCwd]);
		expect(result).toMatchObject({ code: 1, signal: null });
		expect(result.stderr).toContain("Error: --session-cwd requires --session");
		expect(existsSync(fixture.marker)).toBe(false);
	});

	it.each([
		["--fork", "fixture.jsonl"],
		["--continue"],
		["-c"],
		["--resume"],
		["-r"],
		["--session-id", "other-id"],
		["--no-session"],
	])("rejects the conflicting selector %s before loading extensions", async (...flags) => {
		const fixture = setup();
		const result = await runCli(fixture, [
			"--session",
			fixture.sessionFile,
			"--session-cwd",
			fixture.launchCwd,
			...flags,
		]);
		expect(result).toMatchObject({ code: 1, signal: null });
		expect(result.stderr).toContain("Error: --session-cwd cannot be combined with");
		expect(existsSync(fixture.marker)).toBe(false);
		expect(readFileSync(fixture.sessionFile, "utf8")).toBe(fixture.bytes);
	});

	it.each(["missing", "empty"])("rejects a %s override value", async (kind) => {
		const fixture = setup();
		const result = await runCli(fixture, [
			"--session",
			fixture.sessionFile,
			"--session-cwd",
			...(kind === "empty" ? [""] : []),
		]);
		expect(result).toMatchObject({ code: 1, signal: null });
		expect(result.stderr).toContain("Error: --session-cwd requires a");
		expect(existsSync(fixture.marker)).toBe(false);
	});

	it("keeps the launching-cwd fallback for headers without a cwd", async () => {
		const fixture = setup();
		const bytes = `${[{ ...fixture.header, cwd: undefined }, ...fixture.entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
		writeFileSync(fixture.sessionFile, bytes);
		const result = await runCli(fixture, ["--session", fixture.sessionFile]);
		expect(result, result.stderr).toMatchObject({ code: 0, signal: null, stderr: "" });
		const snapshot = JSON.parse(readFileSync(fixture.snapshot, "utf8"));
		expect(snapshot).toMatchObject({
			cwd: fixture.launchCwd,
			sessionCwd: fixture.launchCwd,
			sessionId,
			entries: fixture.entries,
		});
		expect(snapshot.header).not.toHaveProperty("cwd");
		expect(readFileSync(fixture.sessionFile, "utf8")).toBe(bytes);
	});

	it("keeps the saved cwd when the override is omitted", async () => {
		const fixture = setup();
		const result = await runCli(fixture, ["--session", fixture.sessionFile]);
		expectSelected(fixture, result, fixture.originalCwd);
	});
});
