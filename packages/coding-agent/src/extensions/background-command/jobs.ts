import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { getBackgroundCommandWorker } from "../../config.ts";
import type { ReadonlySessionManager } from "../../core/session-manager.ts";
import { type BashSpawnContext, createLocalBashOperations } from "../../core/tools/bash.ts";
import { truncateTail } from "../../core/tools/truncate.ts";

export interface BackgroundCommandJob {
	id: string;
	command: string;
	cwd: string;
	createdAt: string;
	logFile: string;
	timeout?: number;
	pid?: number;
	status: "starting" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out" | "unknown";
	exitCode?: number | null;
	error?: string;
	finishedAt?: string;
}
interface JobRecord {
	job: BackgroundCommandJob;
	command: string;
	shellPath?: string;
	launcherPid: number;
}

export function backgroundCommandDirectory(
	owner: Pick<ReadonlySessionManager, "getSessionDir" | "getSessionId">,
): string {
	return resolve(owner.getSessionDir(), "background-commands", owner.getSessionId());
}
export function backgroundCommandFinished(job: Pick<BackgroundCommandJob, "status">): boolean {
	return job.status !== "starting" && job.status !== "running";
}
export function summarizeBackgroundCommand({ command, ...job }: BackgroundCommandJob) {
	return { ...job, commandPreview: command.slice(0, 160) };
}
function saveJson(path: string, value: unknown): void {
	writeFileSync(`${path}.tmp`, JSON.stringify(value), { mode: 0o600 });
	renameSync(`${path}.tmp`, path);
}
export function readBackgroundCommand(root: string, id: string): BackgroundCommandJob {
	if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid background job ID");
	const directory = join(root, id);
	const record: JobRecord = JSON.parse(readFileSync(join(directory, "job.json"), "utf8"));
	const job = record.job;
	const state = join(directory, "state.json");
	if (job && existsSync(state)) Object.assign(job, JSON.parse(readFileSync(state, "utf8")));
	if (
		!job ||
		job.id !== id ||
		typeof job.command !== "string" ||
		typeof job.createdAt !== "string" ||
		typeof job.logFile !== "string" ||
		!["starting", "running", "succeeded", "failed", "cancelled", "timed_out", "unknown"].includes(job.status)
	) {
		throw new Error("Invalid background job record");
	}
	if (!backgroundCommandFinished(job)) {
		try {
			process.kill(job.pid ?? record.launcherPid, 0);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ESRCH" && code !== "EPERM") throw error;
			job.status = "unknown";
			job.error = `Background worker ${code === "EPERM" ? "is inaccessible" : "exited"}; command outcome is unknown. The command was not restarted.`;
		}
	}
	return job;
}
export function listBackgroundCommands(root: string): BackgroundCommandJob[] {
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && /^[a-f0-9-]{36}$/.test(entry.name))
		.map((entry): BackgroundCommandJob => {
			try {
				return readBackgroundCommand(root, entry.name);
			} catch (error) {
				return {
					id: entry.name,
					command: "",
					cwd: "",
					createdAt: "",
					logFile: join(root, entry.name, "output.log"),
					status: "unknown",
					error: `Cannot read background job record: ${String(error).slice(0, 512)}. Inspect ${join(root, entry.name)}. The command was not restarted.`,
				};
			}
		})
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export function backgroundCommandOutputTail(
	job: BackgroundCommandJob,
	{ maxLines = 100, maxBytes = 16_384 } = {},
): string {
	if (job.status === "unknown" && !existsSync(job.logFile)) return "";
	let fd: number | undefined;
	try {
		fd = openSync(job.logFile, "r");
		const size = fstatSync(fd).size;
		const bytes = Buffer.alloc(Math.min(size, maxBytes));
		const count = readSync(fd, bytes, 0, bytes.length, size - bytes.length);
		let start = 0;
		if (size > bytes.length) while (start < count && (bytes[start] & 0xc0) === 0x80) start++;
		const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes.subarray(start, count), {
			stream: !backgroundCommandFinished(job),
		});
		return truncateTail(stripVTControlCharacters(text), { maxLines, maxBytes }).content;
	} catch (error) {
		return truncateTail(
			stripVTControlCharacters(`Output unavailable: ${String(error).slice(0, 512)}. Inspect logFile for this job.`),
			{ maxLines, maxBytes },
		).content;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}
export async function startBackgroundCommand(
	root: string,
	command: string,
	context: BashSpawnContext,
	options: { shellPath?: string; timeout?: number; signal?: AbortSignal } = {},
): Promise<BackgroundCommandJob> {
	options.signal?.throwIfAborted();
	if (
		options.timeout !== undefined &&
		(!Number.isFinite(options.timeout) || options.timeout <= 0 || options.timeout * 1000 > 2_147_483_647)
	) {
		throw new Error("Invalid timeout: must be a finite positive number of seconds, at most 2147483.647");
	}
	const id = randomUUID();
	const directory = resolve(root, id);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const job: BackgroundCommandJob = {
		id,
		command,
		cwd: context.cwd,
		createdAt: new Date().toISOString(),
		logFile: join(directory, "output.log"),
		timeout: options.timeout,
		status: "starting",
	};
	const record: JobRecord = { job, command: context.command, shellPath: options.shellPath, launcherPid: process.pid };
	saveJson(join(directory, "job.json"), record);
	const log = openSync(job.logFile, "a", 0o600);
	const cancel = () => writeFileSync(join(directory, "cancel"), "");
	try {
		const worker = getBackgroundCommandWorker();
		const child = spawn(worker.command, [...worker.args, directory], {
			cwd: worker.cwd,
			detached: true,
			stdio: ["ignore", log, log, "ipc"],
			env: context.env,
			windowsHide: true,
		});
		job.pid = child.pid;
		saveJson(join(directory, "job.json"), record);
		options.signal?.addEventListener("abort", cancel, { once: true });
		if (options.signal?.aborted) cancel();
		try {
			await new Promise<void>((ready, reject) => {
				child.once("error", reject);
				child.once("exit", () => ready());
				child.once("message", () => ready());
			});
		} finally {
			options.signal?.removeEventListener("abort", cancel);
			if (child.connected) child.disconnect();
			child.unref();
		}
	} catch (error) {
		if (!existsSync(join(directory, "state.json")))
			saveJson(join(directory, "state.json"), {
				status: options.signal?.aborted ? "cancelled" : "failed",
				error: String(error),
				finishedAt: new Date().toISOString(),
			});
		throw error;
	} finally {
		closeSync(log);
	}
	return readBackgroundCommand(root, id);
}
export async function cancelBackgroundCommand(
	root: string,
	id: string,
	signal?: AbortSignal,
): Promise<BackgroundCommandJob> {
	let job = readBackgroundCommand(root, id);
	if (!backgroundCommandFinished(job)) {
		// File requests cannot accidentally signal a reused PID, and work after detachment on Windows.
		writeFileSync(join(root, id, "cancel"), "");
		for (let i = 0; i < 40 && !backgroundCommandFinished(job); i++) {
			await delay(50, undefined, { signal });
			job = readBackgroundCommand(root, id);
		}
	}
	return job;
}

/** Only the detached worker executes the shell; it never writes the session journal. */
export async function runBackgroundCommandWorker(directory: string): Promise<void> {
	const record: JobRecord = JSON.parse(readFileSync(join(directory, "job.json"), "utf8"));
	const controller = new AbortController();
	const abort = () => controller.abort();
	process.on("SIGTERM", abort);
	process.on("SIGINT", abort);
	const checkCancel = () => {
		if (existsSync(join(directory, "cancel"))) controller.abort();
	};
	const timer = setInterval(checkCancel, 100);
	const save = (state: Partial<BackgroundCommandJob>) =>
		saveJson(join(directory, "state.json"), { pid: process.pid, ...state });
	const log = openSync(record.job.logFile, "a");
	try {
		checkCancel();
		save({ status: "running" });
		process.send?.("ready", () => {
			if (process.connected) process.disconnect();
		});
		const { exitCode } = await createLocalBashOperations({ shellPath: record.shellPath }).exec(
			record.command,
			record.job.cwd,
			{
				onData: (data) => {
					writeFileSync(log, data);
				},
				signal: controller.signal,
				timeout: record.job.timeout,
				env: process.env,
			},
		);
		save({ status: exitCode === 0 ? "succeeded" : "failed", exitCode, finishedAt: new Date().toISOString() });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const timedOut = message.startsWith("timeout:");
		const reason = timedOut ? `Command timed out after ${record.job.timeout} seconds` : message;
		writeFileSync(log, `${reason}\n`);
		save({
			status: controller.signal.aborted ? "cancelled" : timedOut ? "timed_out" : "failed",
			error: reason,
			finishedAt: new Date().toISOString(),
		});
	} finally {
		closeSync(log);
		clearInterval(timer);
		process.off("SIGTERM", abort);
		process.off("SIGINT", abort);
	}
}
