import { type ChildProcess, spawn } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { constants } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import {
	MANAGED_CLI_ENV,
	parseRestartCommand,
	RESTART_HANDOFF_ENV,
	RESTART_SOCKET_ENV,
	type RestartHandoff,
	type RestartWorkerMessage,
	requestRestart,
} from "./restart-protocol.ts";

interface Launch {
	worker: string;
	args: string[];
}

export function getCliWorkerPath(launcherPath: string): string {
	return join(
		dirname(launcherPath),
		basename(launcherPath) === "cli.js" ? "cli-worker.js" : `cli${extname(launcherPath)}`,
	);
}

export function getRestartRuntimeWorker(runtime: string): string {
	const worker = realpathSync(join(runtime, "dist", "bundle", "cli-worker.js"));
	if (!statSync(worker).isFile()) throw new Error("Restart runtime must contain dist/bundle/cli-worker.js");
	return worker;
}

/** Only this parent owns process replacement. Normal exits and signals never restart a worker. */
export async function superviseCli(
	worker: string,
	args: string[],
	options: { startupTimeoutMs?: number; env?: NodeJS.ProcessEnv; execArgv?: string[] } = {},
): Promise<number> {
	let launch: Launch = { worker: realpathSync(worker), args };
	let fallback: Launch | undefined;
	let handoff: RestartHandoff | undefined;
	let child: ChildProcess | undefined;
	let stopping: NodeJS.Signals | undefined;
	const env = { ...(options.env ?? process.env) };
	// Nested Pi processes must not inherit the outer session's restart endpoint or continuation.
	delete env[RESTART_SOCKET_ENV];
	delete env[RESTART_HANDOFF_ENV];
	delete env[MANAGED_CLI_ENV];
	const signals: NodeJS.Signals[] =
		process.platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"];
	const signalHandlers = signals.map((signal) => {
		const handler = () => {
			stopping = signal;
			child?.kill(signal);
		};
		process.on(signal, handler);
		return () => process.off(signal, handler);
	});
	const killChild = () => child?.kill("SIGTERM");
	process.on("exit", killChild);
	try {
		while (!stopping) {
			let ready = false;
			let restart: Extract<RestartWorkerMessage, { type: "pi:restart" }> | undefined;
			let timedOut = false;
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
			const workerProcess = child;
			workerProcess.on("message", (message: unknown) => {
				if (!message || typeof message !== "object" || !("type" in message)) return;
				if (message.type === "pi:ready" && !timedOut) {
					ready = true;
					fallback = undefined;
					clearTimeout(timeout);
				} else if (message.type === "pi:restart" && ready && !stopping) {
					restart = message as Extract<RestartWorkerMessage, { type: "pi:restart" }>;
				}
			});
			// Initial startup may involve login/trust dialogs. Only an explicitly requested replacement has a deadline.
			if (handoff) {
				timeout = setTimeout(() => {
					timedOut = true;
					workerProcess.kill("SIGTERM");
					killTimeout = setTimeout(() => workerProcess.kill("SIGKILL"), 2000);
					killTimeout.unref();
				}, options.startupTimeoutMs ?? 60_000);
				timeout.unref();
			}
			const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise) => {
				workerProcess.on("error", (error) => {
					console.error(`Pi worker failed to start: ${error.message}`);
					resolvePromise({ code: 1, signal: null });
				});
				workerProcess.on("exit", (code, signal) => resolvePromise({ code, signal }));
			});
			clearTimeout(timeout);
			clearTimeout(killTimeout);
			child = undefined;
			if (stopping) return 128 + constants.signals[stopping];
			if (restart && result.code === 0 && !result.signal) {
				const checkpoint = restart.checkpoint;
				const resumeArgs = [
					...restart.args,
					"--session",
					checkpoint.sessionFile,
					"--session-cwd",
					checkpoint.cwd,
					"--thinking",
					checkpoint.thinkingLevel,
					...(checkpoint.model
						? [
								"--provider",
								checkpoint.model.provider,
								"--model",
								`${checkpoint.model.provider}/${checkpoint.model.id}`,
							]
						: []),
				];
				const previous: Launch = {
					worker: launch.worker,
					args: [...resumeArgs, ...restart.extensions.flatMap((path) => ["-e", path])],
				};
				try {
					const extensions = restart.request.extensions ?? restart.extensions;
					launch = {
						worker: restart.request.runtime ? getRestartRuntimeWorker(restart.request.runtime) : previous.worker,
						args: [...resumeArgs, ...extensions.flatMap((path) => ["-e", path])],
					};
					fallback = previous;
					handoff = {
						checkpoint: restart.checkpoint,
						message: restart.request.message,
					};
					console.error("Restarting Pi; resuming the same session.");
				} catch (error) {
					launch = previous;
					handoff = {
						checkpoint: restart.checkpoint,
						message: restart.request.message,
						failure: `Could not select the updated runtime: ${error instanceof Error ? error.message : String(error)}`,
					};
					console.error(handoff.failure);
				}
				continue;
			}
			if (!ready && fallback && handoff && (timedOut || result.code !== 0 || result.signal)) {
				const failure = timedOut
					? "Updated Pi did not become ready within the startup deadline."
					: "Updated Pi failed during startup.";
				console.error(`${failure} Returning to the previous launch configuration.`);
				launch = fallback;
				fallback = undefined;
				handoff = { ...handoff, failure };
				continue;
			}
			return result.signal ? 128 + constants.signals[result.signal] : (result.code ?? 1);
		}
		return 1;
	} finally {
		for (const remove of signalHandlers) remove();
		process.off("exit", killChild);
	}
}

export async function runCliLauncher(args: string[], launcherPath: string): Promise<number> {
	if (args[0] === "restart") {
		if (args.length === 2 && (args[1] === "--help" || args[1] === "-h")) {
			console.log(
				"Usage: pi restart [--message <continuation>] [--runtime <built-package-dir>] [-e <extension> ...]\nOmit -e to keep the current explicit extensions; supplying -e replaces that list. Run inside a managed Pi shell tool.",
			);
			return 0;
		}
		const socket = process.env[RESTART_SOCKET_ENV];
		if (!socket) throw new Error("This process has no managed Pi session. Start the updated pi CLI first.");
		const request = parseRestartCommand(args.slice(1), process.cwd());
		request.sessionId = process.env.PI_SESSION_ID;
		console.log(await requestRestart(socket, request));
		return 0;
	}
	return superviseCli(getCliWorkerPath(launcherPath), args);
}
