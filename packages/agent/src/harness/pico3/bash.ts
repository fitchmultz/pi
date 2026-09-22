import { spawn } from "node:child_process";
import { Type } from "typebox";
import { ShellDecoder } from "../utils/shell-decoder.ts";
import type { ToolDeclaration, ToolResult } from "./types.ts";

const parameters = Type.Object({ command: Type.String(), cwd: Type.Optional(Type.String()) });

/** Run a shell command. Output is piped to the kernel; bounds come from `output`. */
export function bashTool(output: ToolDeclaration["output"] = {}): ToolDeclaration<typeof parameters> {
	return {
		name: "bash",
		description: "Run a shell command",
		parameters,
		replay: "unsafe",
		output,
		async execute({ command, cwd }, api, ctx): Promise<ToolResult> {
			const started = Date.now();
			const child = spawn("bash", ["-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
			const decoder = new ShellDecoder();
			const { code, signal } = await new Promise<{ code: number | null; signal: string | null }>(
				(resolve, reject) => {
					let settled = false;
					const publish = (text: string) => {
						if (text) api.stream(text);
					};
					const onAbort = () => child.kill("SIGKILL");
					const listeners = (["stdout", "stderr"] as const).map((source) => {
						const onData = (chunk: Uint8Array) => {
							if (!settled) publish(decoder.push(chunk, source));
						};
						const onEnd = () => {
							if (!settled) publish(decoder.end(source));
						};
						child[source].on("data", onData);
						child[source].once("end", onEnd);
						return { source, onData, onEnd };
					});
					const finish = (code: number | null, signal: string | null, error?: Error) => {
						if (settled) return;
						settled = true;
						ctx.abortSignal?.removeEventListener("abort", onAbort);
						child.removeListener("close", onClose);
						for (const { source, onData, onEnd } of listeners) {
							child[source].removeListener("data", onData);
							child[source].removeListener("end", onEnd);
							child[source].destroy();
						}
						publish(decoder.finish());
						if (error) reject(error);
						else resolve({ code, signal });
					};
					const onClose = (code: number | null, signal: string | null) => finish(code, signal);
					const onError = (error: Error) => {
						if (settled) return;
						child.kill("SIGKILL");
						finish(null, null, error);
					};
					// Retain guards for errors already queued when the streams are destroyed.
					child.on("error", onError);
					child.stdout.on("error", onError);
					child.stderr.on("error", onError);
					child.once("close", onClose);
					ctx.abortSignal?.addEventListener("abort", onAbort, { once: true });
					if (ctx.abortSignal?.aborted) onAbort();
				},
			);
			return { isError: code !== 0, details: { exitCode: code, signal, ms: Date.now() - started } };
		},
	};
}
