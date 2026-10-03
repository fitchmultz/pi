import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync, rmdirSync, rmSync, statSync } from "node:fs";
import { constants } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { assertPrivateFilePath, atomicWriteFileSync } from "../utils/atomic-file.ts";
import { parseArgs } from "./args.ts";
import {
	type CompletedWorkingSession,
	MANAGED_CLI_ENV,
	parseRestartCommand,
	parseRestartRequest,
	RESTART_HANDOFF_ENV,
	RESTART_SOCKET_ENV,
	type RestartHandoff,
	type RestartWorkerMessage,
	requestRestart,
	WORKING_SESSION_LAUNCH_ENV,
	WORKING_SESSION_WORKER_ENV,
} from "./restart-protocol.ts";

interface Launch {
	worker: string;
	args: string[];
	pinnedWorker?: string;
}

function removeRestartArtifact(path: string): void {
	rmSync(path, { force: true });
	if (basename(path) !== "working-session.json" || !basename(dirname(path)).startsWith("pi-restart-state-")) return;
	// Only remove the empty native artifact directory, never recursively delete an IPC path.
	try {
		rmdirSync(dirname(path));
	} catch (error) {
		if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
	}
}

export function getCliWorkerPath(launcherPath: string): string {
	return join(
		dirname(launcherPath),
		basename(launcherPath) === "cli.js" ? "cli-worker.js" : `cli${extname(launcherPath)}`,
	);
}

/** Also used by the fork installer's runtime smoke test. */
export function getRestartRuntimeWorker(runtime: string): string {
	const worker = realpathSync(join(runtime, "dist", "bundle", "cli-worker.js"));
	if (!statSync(worker).isFile()) throw new Error("Restart runtime must contain dist/bundle/cli-worker.js");
	return worker;
}

/** Use the CLI parser's token boundaries; startup messages and attachments are never replayed. */
export function getRestartArgs(args: string[], extensions?: string[]): string[] {
	const result: string[] = [];
	const replaced = new Set([
		"--session",
		"--session-id",
		"--no-session",
		"--continue",
		"-c",
		"--resume",
		"-r",
		"--fork",
		"--name",
		"-n",
		"--thinking",
		"--working-session",
	]);
	// The resumed session restores its current model; a runtime --api-key still needs the launch model.
	if (parseArgs(args).apiKey === undefined) {
		replaced.add("--model");
		replaced.add("--provider");
	}
	if (extensions) {
		replaced.add("--extension");
		replaced.add("-e");
	}
	parseArgs(args, (option, tokens) => {
		if (!replaced.has(option)) result.push(...tokens);
	});
	if (extensions) result.push(...extensions.flatMap((path) => ["-e", path]));
	return result;
}

/** Only this parent replaces workers. Exits and signals do not implicitly request a restart. */
export async function superviseCli(
	worker: string,
	args: string[],
	options: { invocationPath?: string; startupTimeoutMs?: number; env?: NodeJS.ProcessEnv; execArgv?: string[] } = {},
): Promise<number> {
	let launch: Launch = { worker: realpathSync(worker), args };
	let fallback: Launch | undefined;
	let handoff: RestartHandoff | undefined;
	let child: ChildProcess | undefined;
	let stopping: NodeJS.Signals | undefined;
	const restartArtifacts = new Set<string>();
	const env = { ...(options.env ?? process.env) };
	const launchId = randomUUID();
	const exitPath = env.PI_WORKING_SESSION_EXIT_PATH;
	if (exitPath) {
		assertPrivateFilePath(exitPath);
		rmSync(exitPath, { force: true });
	}
	delete env[RESTART_SOCKET_ENV];
	delete env[RESTART_HANDOFF_ENV];
	delete env[MANAGED_CLI_ENV];
	const signals: NodeJS.Signals[] =
		process.platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"];
	const removers = signals.map((signal) => {
		const handler = () => {
			stopping = signal;
			// The terminal already delivers SIGINT/SIGHUP to the foreground process group.
			if (signal === "SIGTERM") child?.kill(signal);
		};
		process.on(signal, handler);
		return () => process.off(signal, handler);
	});
	const killChild = () => child?.kill("SIGTERM");
	process.on("exit", killChild);
	try {
		while (!stopping) {
			let ready = false;
			const workerId = randomUUID();
			let completed: CompletedWorkingSession | undefined;
			let timedOut = false;
			let restart: Extract<RestartWorkerMessage, { type: "pi:restart" }> | undefined;
			let timeout: NodeJS.Timeout | undefined;
			let killTimeout: NodeJS.Timeout | undefined;
			child = spawn(process.execPath, [...(options.execArgv ?? process.execArgv), launch.worker, ...launch.args], {
				stdio: ["inherit", "inherit", "inherit", "ipc"],
				env: {
					...env,
					[MANAGED_CLI_ENV]: "1",
					[WORKING_SESSION_LAUNCH_ENV]: launchId,
					[WORKING_SESSION_WORKER_ENV]: workerId,
					...(handoff ? { [RESTART_HANDOFF_ENV]: JSON.stringify(handoff) } : {}),
				},
			});
			const current = child;
			current.on("message", (value: unknown) => {
				if (!value || typeof value !== "object" || !("type" in value) || stopping || timedOut) return;
				if (value.type === "pi:ready") {
					ready = true;
					fallback = undefined;
					for (const path of restartArtifacts) removeRestartArtifact(path);
					restartArtifacts.clear();
					clearTimeout(timeout);
				} else if (value.type === "pi:completed" && exitPath && "completed" in value) {
					const receipt = value.completed;
					if (
						receipt &&
						typeof receipt === "object" &&
						"path" in receipt &&
						receipt.path === `${exitPath}.state` &&
						"digest" in receipt &&
						typeof receipt.digest === "string" &&
						/^[a-f0-9]{64}$/.test(receipt.digest) &&
						"sessionId" in receipt &&
						typeof receipt.sessionId === "string" &&
						"pid" in receipt &&
						receipt.pid === current.pid &&
						"worker" in receipt &&
						receipt.worker === workerId &&
						"launch" in receipt &&
						receipt.launch === launchId
					)
						completed = receipt as CompletedWorkingSession;
				} else if (value.type === "pi:restart" && ready && "session" in value && "request" in value) {
					try {
						const session = value.session;
						if (
							!session ||
							typeof session !== "object" ||
							!("sessionFile" in session) ||
							typeof session.sessionFile !== "string" ||
							!("sessionId" in session) ||
							typeof session.sessionId !== "string" ||
							!session.sessionId ||
							!("workingSession" in session) ||
							typeof session.workingSession !== "string"
						)
							return;
						assertPrivateFilePath(session.workingSession);
						if (!statSync(session.workingSession).isFile()) return;
						restart = {
							type: "pi:restart",
							session: {
								sessionFile: session.sessionFile,
								sessionId: session.sessionId,
								workingSession: session.workingSession,
							},
							request: parseRestartRequest(value.request),
						};
					} catch {
						/* Ignore malformed IPC from a worker. */
					}
				}
			});
			if (handoff) {
				timeout = setTimeout(() => {
					timedOut = true;
					current.kill("SIGTERM");
					killTimeout = setTimeout(() => current.kill("SIGKILL"), 2000);
				}, options.startupTimeoutMs ?? 60_000);
			}
			const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise) => {
				current.on("error", (error) => {
					console.error(`Pi worker failed to start: ${error.message}`);
					resolvePromise({ code: 1, signal: null });
				});
				current.on("exit", (code, signal) => resolvePromise({ code, signal }));
			});
			clearTimeout(timeout);
			clearTimeout(killTimeout);
			child = undefined;
			const exitCode = result.signal ? 128 + constants.signals[result.signal] : timedOut ? 1 : (result.code ?? 1);
			if (stopping) return exitCode;
			if (restart && result.code === 0 && !result.signal) {
				restartArtifacts.add(restart.session.workingSession);
				const selection = ["--working-session", restart.session.workingSession];
				const previous: Launch = {
					...launch,
					args: [...getRestartArgs(launch.args), ...selection],
				};
				handoff = { ...restart.session, message: restart.request.message, extensions: restart.request.extensions };
				try {
					const pinnedWorker = restart.request.runtime
						? getRestartRuntimeWorker(restart.request.runtime)
						: launch.pinnedWorker;
					launch = {
						worker:
							pinnedWorker ??
							(options.invocationPath
								? realpathSync(getCliWorkerPath(realpathSync(options.invocationPath)))
								: launch.worker),
						args: [...getRestartArgs(launch.args, restart.request.extensions), ...selection],
						pinnedWorker,
					};
					fallback = previous;
					console.error("Restarting Pi; resuming the same session.");
				} catch (error) {
					launch = previous;
					fallback = undefined;
					handoff.failure = `Could not select the updated runtime: ${error instanceof Error ? error.message : String(error)}`;
					console.error(handoff.failure);
				}
				continue;
			}
			if (!ready && fallback && handoff) {
				const failure = timedOut
					? `Updated Pi did not become ready within ${(options.startupTimeoutMs ?? 60_000) / 1000} seconds.`
					: "Updated Pi exited before becoming ready.";
				console.error(`${failure} Returning to the previous launch configuration once.`);
				launch = fallback;
				fallback = undefined;
				handoff = { ...handoff, failure, extensions: undefined };
				continue;
			}
			if (ready && completed && result.code === 0 && !result.signal && exitPath) {
				assertPrivateFilePath(completed.path);
				assertPrivateFilePath(exitPath);
				const bytes = readFileSync(completed.path);
				// Native finalization owns the full codec; the launcher checks its exact identity and bytes.
				const artifact: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
				if (
					createHash("sha256").update(bytes).digest("hex") !== completed.digest ||
					!artifact ||
					typeof artifact !== "object" ||
					!("version" in artifact) ||
					artifact.version !== 1 ||
					!("header" in artifact) ||
					!artifact.header ||
					typeof artifact.header !== "object" ||
					!("id" in artifact.header) ||
					artifact.header.id !== completed.sessionId
				)
					throw new Error("Native completed-exit artifact mismatch");
				atomicWriteFileSync(
					exitPath,
					`${JSON.stringify({ version: 1, ...completed, launcherPid: process.pid, launcher: launchId })}\n`,
				);
			}
			return exitCode;
		}
		return stopping ? 128 + constants.signals[stopping] : 1;
	} finally {
		for (const path of restartArtifacts) removeRestartArtifact(path);
		for (const remove of removers) remove();
		process.off("exit", killChild);
	}
}

export async function runCliLauncher(args: string[], launcherPath: string): Promise<number> {
	if (args[0] === "restart") {
		if (args.length === 2 && (args[1] === "--help" || args[1] === "-h")) {
			console.log(`Usage: pi restart [--message <text>] [-e <extension> ...] [--runtime <package-dir>]
Queue a restart from a managed interactive Pi shell tool; activation waits for final idle.
  --message <text>         Submit a labelled continuation once after startup.
  -e, --extension <path>   Replace explicit extensions; omit to preserve them.
  --runtime <dir>          Pin dist/bundle/cli-worker.js for later restarts.
  -h, --help              Show this help.
Without --runtime, keep a pin or re-resolve the original invocation symlink.
Keep the previous runtime and extensions intact for one-shot startup rollback.
Examples:
  pi restart --message "Verify the change and continue"
  pi restart -e /staged/extension.ts --runtime /staged/pi-coding-agent
Exit codes: 0 = queued (or help); 1 = invalid options, unavailable session, or refused request.`);
			return 0;
		}
		const socket = process.env[RESTART_SOCKET_ENV];
		if (!socket)
			throw new Error("pi restart requires a managed interactive Pi session; run it from that Pi's shell tool.");
		const request = parseRestartCommand(args.slice(1), process.cwd());
		request.sessionId = process.env.PI_SESSION_ID;
		console.log(await requestRestart(socket, request));
		return 0;
	}
	const invocationPath = resolve(launcherPath);
	return superviseCli(getCliWorkerPath(realpathSync(invocationPath)), args, { invocationPath });
}
