import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import {
	closeOpenAICodexWebSocketSessions,
	stream,
} from "/pi-performance-source/packages/ai/src/api/openai-codex-responses.ts";
import { normalizeContext } from "/pi-performance-source/packages/ai/src/utils/transcript.ts";
import { witness } from "../proof.mjs";

// Exercises actual native conversion, immutable baselines, continuation comparison and socket queues. No real transport.
delete process.env.PI_CACHE_TRACE_DIR;
const smoke = process.argv.includes("--smoke");
const option = (name, fallback) =>
	Number(process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1] ?? fallback);
const messages = option("messages", smoke ? 4 : 3000);
const bytes = option("bytes", smoke ? 128 : 1024);
const samples = option("samples", smoke ? 1 : 7);
const burst = option("burst", smoke ? 4 : 1);
for (const value of [messages, bytes, samples, burst]) assert.ok(Number.isSafeInteger(value) && value > 0);
const model = {
	id: "perf",
	name: "perf",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://example.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000000,
	maxTokens: 1000,
};
const history = Array.from({ length: messages }, (_, i) => ({
	role: "user",
	content: `message ${i}: ${"x".repeat(bytes)}`,
	timestamp: i + 1,
}));
const token = `aaa.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fake-benchmark-account" } })).toString("base64")}.bbb`;
let sends = [];
class MockWebSocket extends EventTarget {
	static OPEN = 1;
	readyState = 1;
	constructor() {
		super();
		queueMicrotask(() => this.dispatchEvent(new Event("open")));
	}
	send(data) {
		sends.push(data);
		const id = `resp_${sends.length}`;
		queueMicrotask(() => {
			// Non-output heartbeat events make a controlled queue backlog without changing the response input baseline.
			for (let i = 0; i < burst; i++)
				this.dispatchEvent(
					Object.assign(new Event("message"), {
						data: JSON.stringify({ type: "response.created", response: { id } }),
					}),
				);
			this.dispatchEvent(
				Object.assign(new Event("message"), {
					data: JSON.stringify({
						type: "response.completed",
						response: {
							id,
							status: "completed",
							output: [],
							usage: {
								input_tokens: 5,
								output_tokens: 0,
								total_tokens: 5,
								input_tokens_details: { cached_tokens: 0 },
							},
						},
					}),
				}),
			);
		});
	}
	close() {
		this.readyState = 3;
	}
}
globalThis.WebSocket = MockWebSocket;
globalThis.fetch = async () => {
	throw new Error("network disabled in offline benchmark");
};
const options = {
	apiKey: token,
	sessionId: "offline-performance",
	transport: "websocket-cached",
	maxRetries: 0,
	fetch: globalThis.fetch,
};
async function run() {
	sends = [];
	closeOpenAICodexWebSocketSessions();
	let retained;
	const first = await stream(model, normalizeContext({ systemPrompt: "system", messages: history }), {
		...options,
		onPayload: (payload) => {
			retained = payload;
		},
	}).result();
	assert.equal(first.stopReason, "stop", first.errorMessage);
	// Required fork guarantee: retaining and mutating a hook's payload must not alter continuation state.
	retained.instructions = "mutated after first request";
	const second = await stream(
		model,
		normalizeContext({
			systemPrompt: "system",
			messages: [...history, first, { role: "user", content: "next", timestamp: messages + 2 }],
		}),
		options,
	).result();
	assert.equal(second.stopReason, "stop", second.errorMessage);
	closeOpenAICodexWebSocketSessions();
	return sends;
}
const rows = [];
try {
	if (!smoke) await run();
	for (let i = 0; i < samples; i++) {
		globalThis.gc?.();
		const cpu = process.cpuUsage();
		const heap = process.memoryUsage().heapUsed;
		const start = performance.now();
		const envelopes = await run();
		const ms = performance.now() - start;
		const cpuUsed = process.cpuUsage(cpu);
		const heapDelta = process.memoryUsage().heapUsed - heap;
		// Decode mock wire receipts outside measured time.
		assert.equal(envelopes.length, 2);
		const full = JSON.parse(envelopes[0]);
		const delta = JSON.parse(envelopes[1]);
		assert.equal(full.previous_response_id, undefined);
		assert.equal(delta.previous_response_id, "resp_1");
		assert.equal(delta.input.length, 1);
		assert.equal(delta.input[0].content[0].text, "next");
		witness("codex", { messages, bytes, burst, history }, envelopes);
		rows.push({
			msPerPair: ms,
			cpuMsPerPair: (cpuUsed.user + cpuUsed.system) / 1000,
			transientHeapDelta: heapDelta,
			firstEnvelopeChars: envelopes[0].length,
			deltaEnvelopeChars: envelopes[1].length,
		});
	}
} finally {
	closeOpenAICodexWebSocketSessions();
}
console.log(
	JSON.stringify({
		node: process.version,
		revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: process.env.PI_PERF_REPO, encoding: "utf8" }).trim(),
		smoke,
		messages,
		bytes,
		burst,
		samples,
		rows,
	}),
);
