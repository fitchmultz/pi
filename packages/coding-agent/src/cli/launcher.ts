import { type ChildProcess, spawn } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { constants } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { parseArgs } from "./args.ts";
import {
	MANAGED_CLI_ENV,
	parseRestartCommand,
	parseRestartRequest,
	RESTART_HANDOFF_ENV,
	RESTART_SOCKET_ENV,
	type RestartHandoff,
	type RestartWorkerMessage,
	requestRestart,
} from "./restart-protocol.ts";

interface Launch {
	worker: string;
	args: string[];
	pinnedWorker?: string;
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
	]);
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
	const env = { ...(options.env ?? process.env) };
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
			let timedOut = false;
			let restart: Extract<RestartWorkerMessage, { type: "pi:restart" }> | undefined;
			let timeout: NodeJS.Timeout | undefined;
			let killTimeout: NodeJS.Timeout | undefined;
			child = spawn(process.execPath, [...(options.execArgv ?? process.execArgv), launch.worker, ...launch.args], {
				stdio: ["inherit", "inherit", "inherit", "ipc"],
				env: {
					...env,
					[MANAGED_CLI_ENV]: "1",
					...(handoff ? { [RESTART_HANDOFF_ENV]: JSON.stringify(handoff) } : {}),
				},
			});
			const current = child;
			current.on("message", (value: unknown) => {
				if (!value || typeof value !== "object" || !("type" in value) || stopping || timedOut) return;
				if (value.type === "pi:ready") {
					ready = true;
					fallback = undefined;
					clearTimeout(timeout);
				} else if (value.type === "pi:restart" && ready && "session" in value && "request" in value) {
					try {
						const session = value.session;
						if (
							!session ||
							typeof session !== "object" ||
							!("sessionFile" in session) ||
							typeof session.sessionFile !== "string" ||
							!("sessionId" in session) ||
							typeof session.sessionId !== "string"
						)
							return;
						restart = {
							type: "pi:restart",
							session: { sessionFile: session.sessionFile, sessionId: session.sessionId },
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
				const previous: Launch = {
					...launch,
					args: [...getRestartArgs(launch.args), "--session", restart.session.sessionFile],
				};
				handoff = { ...restart.session, message: restart.request.message };
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
						args: [
							...getRestartArgs(launch.args, restart.request.extensions),
							"--session",
							restart.session.sessionFile,
						],
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
				handoff = { ...handoff, failure };
				continue;
			}
			return exitCode;
		}
		return stopping ? 128 + constants.signals[stopping] : 1;
	} finally {
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
