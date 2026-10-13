import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { Agent } from "/pi-performance-source/packages/agent/src/agent.ts";
import { transformMessages } from "/pi-performance-source/packages/ai/src/api/transform-messages.ts";
import { Type } from "/pi-performance-source/packages/ai/src/index.ts";
import {
	AssistantMessageFrameEncoder,
	reduceAssistantMessageFrames,
} from "/pi-performance-source/packages/ai/src/utils/assistant-message-frame.ts";
import { estimateContextTokens } from "/pi-performance-source/packages/ai/src/utils/estimate.ts";
import { AssistantMessageEventStream, EventStream } from "/pi-performance-source/packages/ai/src/utils/event-stream.ts";
import { parseStreamingJson, repairJson } from "/pi-performance-source/packages/ai/src/utils/json-parse.ts";
import {
	getCurrentTools,
	getToolStateChanges,
	toToolDeclaration,
} from "/pi-performance-source/packages/ai/src/utils/transcript.ts";
import { validateToolArguments } from "/pi-performance-source/packages/ai/src/utils/validation.ts";
import { witness } from "../proof.mjs";

const root = process.env.PI_PERF_REPO;
const args = process.argv.slice(2);
const option = (name, fallback) => {
	const entry = args.find((arg) => arg.startsWith(`--${name}=`));
	return entry ? entry.slice(name.length + 3) : fallback;
};
const smoke = args.includes("--smoke");
const integer = (name, fallback) => {
	const value = Number(option(name, fallback));
	assert.ok(Number.isSafeInteger(value) && value > 0, `${name} must be a positive integer`);
	return value;
};
const size = integer("size", smoke ? 512 : 65536);
const chunkSize = integer("chunk", 64);
const toolCount = integer("tools", smoke ? 4 : 128);
const messageCount = integer("messages", smoke ? 12 : 3000);
const eventCount = integer("events", smoke ? 32 : 100000);
const iterations = integer("iterations", smoke ? 1 : 5);
const samples = integer("samples", smoke ? 1 : 7);
const selected = new Set(
	option("cases", "parse,repair,tools,transform,estimate,validate,frames,queued-frames,queue,agent").split(","),
);
const usage = () => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
const model = {
	id: "perf",
	name: "perf",
	provider: "perf",
	api: "perf",
	baseUrl: "",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000000,
	maxTokens: 100000,
};
const answer = (content, stopReason = "stop") => ({
	role: "assistant",
	content,
	api: "perf",
	provider: "perf",
	model: "perf",
	usage: usage(),
	stopReason,
	timestamp: 0,
});
const text = "abcdefgh ijklmnop qrstuvwx yz".repeat(Math.ceil(size / 27)).slice(0, size);
const payload = JSON.stringify({ path: "src/test.ts", content: text });
const prefixes = [];
for (let end = chunkSize; end < payload.length; end += chunkSize) prefixes.push(payload.slice(0, end));
prefixes.push(payload);
const tools = Array.from({ length: toolCount }, (_, i) => ({
	name: `tool_${i}`,
	description: `Tool ${i}. ${"schema documentation ".repeat(30)}`,
	parameters: Type.Object(
		Object.fromEntries(
			Array.from({ length: 8 }, (_, p) => [
				`field_${p}`,
				Type.Optional(Type.String({ description: "field documentation ".repeat(12) })),
			]),
		),
	),
	execute: async () => ({ content: [], details: {} }),
}));
const declared = tools.map(toToolDeclaration);
const history = [{ role: "system", content: "system", toolsAdded: declared, timestamp: 0 }];
for (let i = 1; i <= messageCount; i++) {
	if (i % 3 === 1) history.push({ role: "user", content: text.slice(0, 1024), timestamp: i });
	else if (i % 3 === 2)
		history.push({
			...answer(
				[
					{ type: "thinking", thinking: "thought", thinkingSignature: "signature".repeat(16) },
					{ type: "toolCall", id: `call_${i}`, name: "tool_0", arguments: { field_0: "value" } },
				],
				"toolUse",
			),
			timestamp: i,
		});
	else
		history.push({
			role: "toolResult",
			toolCallId: `call_${i - 1}`,
			toolName: "tool_0",
			content: [{ type: "text", text: text.slice(0, 1024) }],
			isError: false,
			timestamp: i,
		});
}
// End on a non-assistant tail to avoid synthetic orphan output in the transform measurement.
if (history.at(-1).role === "assistant")
	history.push({ role: "user", content: "continue", timestamp: messageCount + 1 });
const validationTool = {
	name: "write",
	description: "Write a file",
	parameters: Type.Object({ path: Type.String(), content: Type.String(), offset: Type.Optional(Type.Number()) }),
};
const validationCall = {
	type: "toolCall",
	id: "c",
	name: "write",
	arguments: { path: "file.ts", content: text, offset: null },
};
assert.deepEqual(validateToolArguments(validationTool, validationCall), { path: "file.ts", content: text });
const toolCall = { type: "toolCall", id: "c", name: "write", arguments: JSON.parse(payload) };
const frameMessage = answer([toolCall], "toolUse");
const toolEvents = [
	{ type: "start", partial: frameMessage },
	{ type: "toolcall_start", contentIndex: 0, partial: frameMessage },
];
for (let start = 0; start < payload.length; start += chunkSize)
	toolEvents.push({
		type: "toolcall_delta",
		contentIndex: 0,
		delta: payload.slice(start, start + chunkSize),
		partial: frameMessage,
	});
toolEvents.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: frameMessage });
const rawFrames = [
	{ type: "start", partial: answer([]) },
	{ type: "toolcall_start", contentIndex: 0, toolCall: { ...toolCall, arguments: {} } },
	...toolEvents.slice(2, -1).map(({ type, contentIndex, delta }) => ({ type, contentIndex, delta })),
];
let sink;
const cases = {
	parse: () => {
		for (const prefix of prefixes) sink = parseStreamingJson(prefix);
		assert.equal(sink.content, text);
	},
	repair: () => {
		sink = repairJson(payload.slice(0, -1));
		assert.equal(sink, payload.slice(0, -1));
	},
	tools: () => {
		sink = getToolStateChanges(getCurrentTools(history), tools.map(toToolDeclaration));
		assert.equal(sink.toolsAdded.length + sink.toolsRemoved.length, 0);
	},
	transform: () => {
		sink = transformMessages(history, model);
		assert.equal(sink[0].role, "system");
	},
	estimate: () => {
		sink = estimateContextTokens(history);
		assert.ok(sink.tokens > 0);
	},
	validate: () => {
		sink = validateToolArguments(validationTool, validationCall);
		assert.equal(sink.content, text);
		assert.equal(sink.offset, undefined);
		assert.equal(validationCall.arguments.offset, null);
	},
	frames: () => {
		sink = reduceAssistantMessageFrames(rawFrames);
		assert.equal(sink.content[0].arguments.content, text);
	},
	"queued-frames": () => {
		const encoder = new AssistantMessageFrameEncoder();
		const frames = [];
		for (const event of toolEvents) {
			const frame = encoder.encode(event);
			if (frame) frames.push(frame);
		}
		sink = reduceAssistantMessageFrames(frames);
		assert.equal(sink.content[0].arguments.content, text);
	},
	queue: async () => {
		const stream = new EventStream(
			() => false,
			(event) => event,
		);
		for (let i = 0; i < eventCount; i++) stream.push(i);
		stream.end(eventCount);
		let sum = 0;
		for await (const event of stream) sum += event;
		assert.equal(sum, (eventCount * (eventCount - 1)) / 2);
		sink = sum;
	},
	agent: async () => {
		const agent = new Agent({
			initialState: { model, tools, messages: history },
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				const message = answer([{ type: "text", text: "ok" }]);
				stream.push({ type: "start", partial: message });
				stream.push({ type: "text_start", contentIndex: 0, partial: message });
				stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
				stream.push({ type: "text_end", contentIndex: 0, content: "ok", partial: message });
				stream.push({ type: "done", reason: "stop", message });
				stream.end();
				return stream;
			},
		});
		let events = 0;
		agent.subscribe(() => {
			events++;
		});
		await agent.prompt("next");
		assert.equal(agent.state.messages.at(-1).content[0].text, "ok");
		assert.ok(events >= 8);
		sink = events;
	},
};
console.log(
	JSON.stringify({
		node: process.version,
		revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
		smoke,
		size,
		chunkSize,
		toolCount,
		messageCount,
		eventCount,
		iterations,
		samples,
	}),
);
for (const [name, run] of Object.entries(cases)) {
	if (!selected.has(name)) continue;
	if (!smoke) await run();
	const timings = [];
	for (let sample = 0; sample < samples; sample++) {
		globalThis.gc?.();
		const cpu = process.cpuUsage();
		const heap = process.memoryUsage().heapUsed;
		const started = performance.now();
		for (let i = 0; i < iterations; i++) await run();
		const elapsedMs = performance.now() - started;
		const cpuUsed = process.cpuUsage(cpu);
		timings.push({
			msPerOperation: elapsedMs / iterations,
			cpuMsPerOperation: (cpuUsed.user + cpuUsed.system) / 1000 / iterations,
			transientHeapDelta: process.memoryUsage().heapUsed - heap,
		});
	}
	const sorted = timings.map((row) => row.msPerOperation).sort((a, b) => a - b);
	console.log(JSON.stringify({ case: name, medianMs: sorted[Math.floor(sorted.length / 2)], timings }));
	witness(name, { payload, declared, history, eventCount, chunkSize }, sink);
}
