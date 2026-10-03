import { connect } from "node:net";
import { isAbsolute, resolve } from "node:path";

export const RESTART_SOCKET_ENV = "PI_RESTART_SOCKET";
export const RESTART_HANDOFF_ENV = "PI_RESTART_HANDOFF";
export const MANAGED_CLI_ENV = "PI_MANAGED_CLI";
export const MAX_RESTART_BYTES = 64 * 1024;
export const WORKING_SESSION_LAUNCH_ENV = "PI_WORKING_SESSION_LAUNCH";
export const WORKING_SESSION_WORKER_ENV = "PI_WORKING_SESSION_WORKER";

/** Headless modes become ready only after their native owner and extensions bind. */
export async function notifyCliReady(): Promise<void> {
	if (!process.env[WORKING_SESSION_LAUNCH_ENV] || !process.send || !process.connected) return;
	await new Promise<void>((resolve, reject) =>
		process.send!({ type: "pi:ready" }, (error) => (error ? reject(error) : resolve())),
	);
}

export interface CompletedWorkingSession {
	path: string;
	digest: string;
	sessionId: string;
	pid: number;
	worker: string;
	launch: string;
}

export interface RestartRequest {
	message?: string;
	runtime?: string;
	extensions?: string[];
	sessionId?: string;
}

export interface RestartSession {
	sessionFile: string;
	sessionId: string;
	workingSession?: string;
}

export interface RestartHandoff extends RestartSession {
	message?: string;
	failure?: string;
	extensions?: string[];
}

export type RestartWorkerMessage =
	| { type: "pi:ready" }
	| { type: "pi:completed"; completed: CompletedWorkingSession }
	| { type: "pi:restart"; request: RestartRequest; session: RestartSession };

export function parseRestartHandoff(encoded: string): RestartHandoff {
	const value: unknown = JSON.parse(encoded);
	if (
		!value ||
		typeof value !== "object" ||
		!("sessionFile" in value) ||
		typeof value.sessionFile !== "string" ||
		!("sessionId" in value) ||
		typeof value.sessionId !== "string"
	) {
		throw new Error("This Pi was started by an older Pi launcher; quit and run pi -c to resume on the new runtime.");
	}
	const fields = value as Record<string, unknown>;
	for (const key of ["message", "failure", "workingSession"] as const) {
		if (fields[key] !== undefined && typeof fields[key] !== "string")
			throw new Error(`Invalid restart handoff ${key}`);
	}
	if (
		fields.extensions !== undefined &&
		(!Array.isArray(fields.extensions) || !fields.extensions.every((path) => typeof path === "string"))
	)
		throw new Error("Invalid restart handoff extensions");
	return value as RestartHandoff;
}

export function parseRestartRequest(value: unknown): RestartRequest {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Restart request must be an object");
	const request = value as Record<string, unknown>;
	for (const key of Object.keys(request)) {
		if (!["message", "runtime", "extensions", "sessionId"].includes(key))
			throw new Error(`Unknown restart option: ${key}`);
	}
	for (const key of ["message", "runtime", "sessionId"] as const) {
		if (request[key] !== undefined && (typeof request[key] !== "string" || request[key].length > 8192)) {
			throw new Error(`Restart ${key} must be a string of at most 8192 characters`);
		}
	}
	if (request.runtime !== undefined && !isAbsolute(request.runtime as string))
		throw new Error("Restart runtime must be an absolute package directory");
	if (
		request.extensions !== undefined &&
		(!Array.isArray(request.extensions) ||
			request.extensions.length > 128 ||
			request.extensions.some(
				(path: unknown) => typeof path !== "string" || (!isAbsolute(path) && !path.startsWith("builtin:")),
			))
	) {
		throw new Error("Restart extensions must be absolute local paths or builtin:<name>");
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
			request.extensions.push(value.startsWith("builtin:") ? value : resolve(cwd, value));
		} else throw new Error(`Unknown restart option: ${flag}`);
	}
	return parseRestartRequest(request);
}

/** The reply acknowledges queueing, not successful activation. */
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
				if (!result || typeof result !== "object" || !("message" in result) || typeof result.message !== "string")
					throw new Error("Invalid restart response");
				if (!("ok" in result) || result.ok !== true) throw new Error(result.message);
				resolvePromise(result.message);
			} catch (error) {
				reject(error);
			}
			socket.destroy();
		});
	});
}
