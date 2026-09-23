import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { constants } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { getActiveManagedInstallRoot } from "./managed-install.ts";
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
	/** A successful --runtime selection stays pinned until another explicit selection. */
	selectedRuntime?: string;
}

interface InstallationSelector {
	launcherPath: string;
	managedRoot?: string;
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

function getManagedRootForInvocation(invocationPath: string, concreteLauncher: string): string | undefined {
	const root = process.env.PI_MANAGED_INSTALL_ROOT?.trim();
	if (!root) return undefined;
	// The install.sh wrapper execs this concrete release bin with the root in its environment.
	// Direct release CLI files and source entries do not opt into its moving version pointer.
	const parts = relative(join(resolve(root), "releases"), invocationPath).split(sep);
	if (
		parts.length !== 4 ||
		!parts[0] ||
		parts[0] === "." ||
		parts[0] === ".." ||
		!/^[0-9A-Za-z._+-]+$/.test(parts[0]) ||
		parts[1] !== "node_modules" ||
		parts[2] !== ".bin" ||
		parts[3] !== "pi"
	) {
		return undefined;
	}
	return getActiveManagedInstallRoot(concreteLauncher, root);
}

function resolveSelectedWorker(selector: InstallationSelector): string {
	let launcherPath = selector.launcherPath;
	if (selector.managedRoot) {
		const currentFile = join(selector.managedRoot, "current-version");
		const version = readFileSync(currentFile, "utf8").split("\n", 1)[0];
		if (!version || version === "." || version === ".." || !/^[0-9A-Za-z._+-]+$/.test(version)) {
			throw new Error(`Managed Pi version file is invalid: ${currentFile}`);
		}
		launcherPath = join(selector.managedRoot, "releases", version, "node_modules", ".bin", "pi");
	}
	// Resolve the launcher first: an npm bin/pi symlink is not beside cli-worker.js.
	return realpathSync(getCliWorkerPath(realpathSync(launcherPath)));
}

/** Only this parent owns process replacement. Normal exits and signals never restart a worker. */
export async function superviseCli(
	worker: string,
	args: string[],
	options: {
		startupTimeoutMs?: number;
		env?: NodeJS.ProcessEnv;
		execArgv?: string[];
		selector?: InstallationSelector;
	} = {},
): Promise<number> {
	const initialWorker = realpathSync(worker);
	let launch: Launch = { worker: initialWorker, args };
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
					selectedRuntime: launch.selectedRuntime,
				};
				try {
					const extensions = restart.request.extensions ?? restart.extensions;
					const selectedRuntime = restart.request.runtime
						? getRestartRuntimeWorker(restart.request.runtime)
						: launch.selectedRuntime;
					launch = {
						worker:
							selectedRuntime ?? (options.selector ? resolveSelectedWorker(options.selector) : initialWorker),
						args: [...resumeArgs, ...extensions.flatMap((path) => ["-e", path])],
						selectedRuntime,
					};
					fallback = previous;
					handoff = {
						checkpoint: restart.checkpoint,
						toolConfiguration: restart.toolConfiguration,
						message: restart.request.message,
					};
					console.error("Restarting Pi; resuming the same session.");
				} catch (error) {
					launch = previous;
					handoff = {
						checkpoint: restart.checkpoint,
						toolConfiguration: restart.toolConfiguration,
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
				"Usage: pi restart [--message <continuation>] [--runtime <built-package-dir>] [-e <extension> ...]\nWithout --runtime, Pi follows the original installation selector or keeps the last explicit runtime. --runtime pins a built package for later restarts. Omit -e to keep the current explicit extensions; supplying -e replaces that list. Run inside a managed Pi shell tool.",
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
	const invocationPath = resolve(launcherPath);
	const concreteLauncher = realpathSync(invocationPath);
	return superviseCli(getCliWorkerPath(concreteLauncher), args, {
		selector: {
			launcherPath: invocationPath,
			managedRoot: getManagedRootForInvocation(invocationPath, concreteLauncher),
		},
	});
}
