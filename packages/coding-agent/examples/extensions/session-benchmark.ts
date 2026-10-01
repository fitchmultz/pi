// Loaded explicitly by scripts/bench-session.mjs; no real provider or credentials.
import { appendFileSync } from "node:fs";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const FINAL_TEXT = `## Result

The read completed. Here is a short summary with **markdown**, \`inline code\`, and a list:

- The file defines a renderer and several helpers.
- Width calculations use \`visibleWidth\` for every line.
- Differential updates compare previous and next lines.

\`\`\`ts
export function sample(lines: string[], width: number): string[] {
  return lines.map((line) => (line.length > width ? line.slice(0, width) : line));
}
\`\`\`

1. First numbered point with a [link](https://example.com).
2. Second numbered point.

Done.`;

export default function (pi: ExtensionAPI) {
	const log = process.env.BENCH_LOG;
	if (!log) throw new Error("Load session-benchmark.ts through scripts/bench-session.mjs drive.");
	const faux = fauxProvider({
		provider: "bench",
		api: "bench",
		models: [{ id: "bench-1", name: "Bench", contextWindow: 2_000_000, maxTokens: 32_000 }],
		tokensPerSecond: Number(process.env.BENCH_TPS ?? "600"),
		tokenSize: { min: 4, max: 4 },
	});
	pi.registerProvider(faux.provider);
	const eld = monitorEventLoopDelay({ resolution: 5 });
	let run = 0;
	let marks: Record<string, number> = {};
	let input: number | undefined;
	let contextMessages = 0;
	let stdoutBytes = 0;
	let stdoutMs = 0;
	let stdoutWrites = 0;
	const originalWrite = process.stdout.write;
	const measuredWrite: typeof process.stdout.write = (chunk, ...args) => {
		const started = performance.now();
		const result = Reflect.apply(originalWrite, process.stdout, [chunk, ...args]) as boolean;
		stdoutMs += performance.now() - started;
		stdoutWrites++;
		stdoutBytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
		return result;
	};
	const mark = (name: string) => {
		marks[name] ??= performance.now();
	};
	const responder: Parameters<typeof faux.setResponses>[0][number] = (context) => {
		faux.appendResponses([responder]);
		const prompt = context.messages.findLastIndex(
			(message) =>
				message.role === "user" &&
				(typeof message.content === "string"
					? message.content
					: message.content
							.filter((block) => block.type === "text")
							.map((block) => block.text)
							.join("")
				).includes("bench prompt"),
		);
		if (prompt < 0) return fauxAssistantMessage("ok");
		if (
			context.messages
				.slice(prompt + 1)
				.some((message) => message.role === "toolResult" && message.toolName === "read")
		) {
			mark("call2");
			return fauxAssistantMessage(FINAL_TEXT);
		}
		mark("call1");
		contextMessages = context.messages.length;
		return fauxAssistantMessage([fauxText("Reading the file."), fauxToolCall("read", { path: "bench-input.ts" })], {
			stopReason: "toolUse",
		});
	};
	faux.setResponses([responder]);
	pi.on("session_start", () => {
		process.stdout.write = measuredWrite;
		appendFileSync(log, `${JSON.stringify({ ready: true, pid: process.pid })}\n`);
	});
	pi.on("input", () => {
		input = performance.now();
	});
	pi.on("agent_start", () => {
		run++;
		marks = {};
		if (input !== undefined) marks.input = input;
		input = undefined;
		mark("agent_start");
		stdoutBytes = stdoutMs = stdoutWrites = 0;
		eld.reset();
		eld.enable();
	});
	pi.on("message_end", ({ message }) => {
		if (message.role === "assistant") mark(marks.call2 === undefined ? "asst1_end" : "asst2_end");
		if (message.role === "toolResult") mark("result_end");
	});
	pi.on("tool_execution_start", () => mark("exec_start"));
	pi.on("tool_execution_end", () => mark("exec_end"));
	pi.on("agent_end", () => {
		mark("agent_end");
		eld.disable();
		const span = (a: string, b: string) =>
			marks[a] === undefined || marks[b] === undefined ? null : marks[b] - marks[a];
		const memory = process.memoryUsage();
		appendFileSync(
			log,
			`${JSON.stringify({
				run,
				contextMessages,
				e2e: span(marks.input === undefined ? "agent_start" : "input", "agent_end"),
				prep1: span("agent_start", "call1"),
				stream1: span("call1", "asst1_end"),
				dispatch: span("asst1_end", "exec_start"),
				exec: span("exec_start", "exec_end"),
				prep2: span("result_end", "call2"),
				stream2: span("call2", "asst2_end"),
				tail: span("asst2_end", "agent_end"),
				eld: { p50: eld.percentile(50) / 1e6, p99: eld.percentile(99) / 1e6, max: eld.max / 1e6 },
				stdout: { bytes: stdoutBytes, writes: stdoutWrites, ms: stdoutMs },
				rssMb: memory.rss / 1048576,
				heapUsedMb: memory.heapUsed / 1048576,
			})}\n`,
		);
	});
	pi.on("session_shutdown", () => {
		eld.disable();
		if (process.stdout.write === measuredWrite) process.stdout.write = originalWrite;
	});
}
