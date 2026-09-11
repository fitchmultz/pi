import { connect } from "node:net";
import { isAbsolute, resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export const RESTART_SOCKET_ENV = "PI_RESTART_SOCKET";
export const RESTART_HANDOFF_ENV = "PI_RESTART_HANDOFF";
export const MANAGED_CLI_ENV = "PI_MANAGED_CLI";
export const MAX_RESTART_BYTES = 64 * 1024;

export interface RestartRequest {
	message?: string;
	/** Built coding-agent package directory; omitted to keep the current runtime. */
	runtime?: string;
	/** Replace the explicit CLI extension list. Omitted means preserve it. */
	extensions?: string[];
	sessionId?: string;
}

export interface RestartCheckpoint {
	sessionFile: string;
	sessionId: string;
	cwd: string;
	leafId: string | null;
	model?: { provider: string; id: string };
	thinkingLevel: ThinkingLevel;
	activeTools: string[];
	knownTools: string[];
}

export interface RestartHandoff {
	checkpoint: RestartCheckpoint;
	message?: string;
	failure?: string;
}

export type RestartWorkerMessage =
	| { type: "pi:ready" }
	| {
			type: "pi:restart";
			request: RestartRequest;
			checkpoint: RestartCheckpoint;
			args: string[];
			extensions: string[];
	  };

export function parseRestartRequest(value: unknown): RestartRequest {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Restart request must be an object");
	}
	const request = value as Record<string, unknown>;
	for (const key of Object.keys(request)) {
		if (!["message", "runtime", "extensions", "sessionId"].includes(key)) {
			throw new Error(`Unknown restart option: ${key}`);
		}
	}
	for (const key of ["message", "runtime", "sessionId"] as const) {
		if (request[key] !== undefined && (typeof request[key] !== "string" || request[key].length > 8192)) {
			throw new Error(`Restart ${key} must be a string of at most 8192 characters`);
		}
	}
	if (request.runtime !== undefined && (typeof request.runtime !== "string" || !isAbsolute(request.runtime))) {
		throw new Error("Restart runtime must be an absolute package directory");
	}
	if (
		request.extensions !== undefined &&
		(!Array.isArray(request.extensions) ||
			request.extensions.length > 128 ||
			request.extensions.some((path: unknown) => typeof path !== "string" || !isAbsolute(path)))
	) {
		throw new Error("Restart extensions must be an array of absolute local paths");
	}
	if (Buffer.byteLength(JSON.stringify(request)) > MAX_RESTART_BYTES) throw new Error("Restart request is too large");
	return request as RestartRequest;
}

export function parseRestartCommand(args: string[], cwd: string): RestartRequest {
	const request: RestartRequest = {};
	for (let i = 0; i < args.length; i++) {
		const flag = args[i];
		const value = args[++i];
		if (value === undefined) throw new Error(`Missing value for ${flag}`);
		if (flag === "--message") request.message = value;
		else if (flag === "--runtime") request.runtime = resolve(cwd, value);
		else if (flag === "--extension" || flag === "-e") {
			request.extensions ??= [];
			request.extensions.push(resolve(cwd, value));
		} else throw new Error(`Unknown restart option: ${flag}`);
	}
	return parseRestartRequest(request);
}

/** Acknowledges queueing only; the worker must settle before it can commit a restart. */
export async function requestRestart(socketPath: string, request: RestartRequest): Promise<string> {
	parseRestartRequest(request);
	return new Promise((resolvePromise, reject) => {
		const socket = connect(socketPath);
		let response = "";
		socket.setEncoding("utf8");
		socket.setTimeout(5000, () => socket.destroy(new Error("Timed out requesting Pi restart")));
		socket.on("error", reject);
		socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
		socket.on("data", (chunk: string) => {
			response += chunk;
			if (Buffer.byteLength(response) > MAX_RESTART_BYTES)
				socket.destroy(new Error("Restart response is too large"));
		});
		socket.on("end", () => {
			try {
				const result: unknown = JSON.parse(response);
				if (!result || typeof result !== "object" || !("message" in result) || typeof result.message !== "string") {
					throw new Error("Invalid restart response");
				}
				if (!("ok" in result) || result.ok !== true) throw new Error(result.message);
				resolvePromise(result.message);
			} catch (error) {
				reject(error);
			}
			socket.destroy();
		});
	});
}
