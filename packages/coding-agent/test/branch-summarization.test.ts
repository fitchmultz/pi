import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	contentText,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { generateBugReportSummary } from "../src/core/bug-report.ts";
import { generateBranchSummary, prepareBranchEntries } from "../src/core/compaction/index.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";

const model: Model<"anthropic-messages"> = {
	id: "test-model",
	name: "Test Model",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
};

const entries = [
	{
		type: "message",
		id: "branch-user",
		parentId: null,
		timestamp: new Date(1).toISOString(),
		message: { role: "user", content: "Abandoned request", timestamp: 1 },
	},
] satisfies SessionEntry[];

function response(content: AssistantMessage["content"]): AssistantMessage {
	return {
		...fauxAssistantMessage(""),
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
	};
}

describe("branch summarization", () => {
	// Upstream #9409: signatures count in replay context, but are not sent to text summarizers.
	it.each(["branch", "bug-report"] as const)("keeps history with large signatures in %s summaries", async (kind) => {
		const signed = response([
			{ type: "thinking", thinking: "reasoning", thinkingSignature: "s".repeat(1_000_000) },
			{ type: "text", text: "answer" },
		]);
		const history: SessionEntry[] = [
			...entries,
			{
				type: "message",
				id: "signed",
				parentId: "branch-user",
				timestamp: new Date(2).toISOString(),
				message: signed,
			},
		];
		let prompt = "";
		const streamFn: StreamFn = (_model, context) => {
			prompt = context.messages
				.filter((message) => message.role === "user")
				.map((message) => contentText(message.content))
				.join("\n");
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() =>
				stream.push({ type: "done", reason: "stop", message: response([{ type: "text", text: "summary" }]) }),
			);
			return stream;
		};
		const options = { model, signal: new AbortController().signal, streamFn };
		if (kind === "branch") await generateBranchSummary(history, options);
		else await generateBugReportSummary({ ...options, messages: [entries[0].message, signed] });
		expect(prompt).toContain("Abandoned request");
		expect(prompt).toContain("reasoning");
		expect(prompt).not.toContain("s".repeat(100));
	});

	it("budgets conversation without system declarations", () => {
		const system: SessionEntry = {
			type: "message",
			id: "branch-system",
			parentId: "branch-user",
			timestamp: new Date(2).toISOString(),
			message: {
				role: "system",
				content: "Tool and system declarations ".repeat(1000),
				timestamp: 2,
			},
		};
		const prepared = prepareBranchEntries([...entries, system], 100);
		expect(prepared.messages).toEqual([{ role: "user", content: "Abandoned request", timestamp: 1 }]);
		expect(prepared.totalTokens).toBeGreaterThan(0);
		expect(prepared.totalTokens).toBeLessThan(100);
	});

	it("does not override tool choice for branch summaries", async () => {
		let requestOptions: SimpleStreamOptions | undefined;
		const streamFn: StreamFn = (_model, _context, options) => {
			requestOptions = options;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() =>
				stream.push({ type: "done", reason: "stop", message: response([{ type: "text", text: "summary" }]) }),
			);
			return stream;
		};

		await generateBranchSummary(entries, {
			model,
			signal: new AbortController().signal,
			streamFn,
		});

		expect(requestOptions?.maxTokens).toBe(4096);
		expect(requestOptions?.toolChoice).toBeUndefined();
	});

	it("clamps the branch summary output cap to the model limit", async () => {
		let requestOptions: SimpleStreamOptions | undefined;
		const streamFn: StreamFn = (_model, _context, options) => {
			requestOptions = options;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() =>
				stream.push({ type: "done", reason: "stop", message: response([{ type: "text", text: "summary" }]) }),
			);
			return stream;
		};

		await generateBranchSummary(entries, {
			model: { ...model, maxTokens: 1024 },
			signal: new AbortController().signal,
			streamFn,
		});

		expect(requestOptions?.maxTokens).toBe(1024);
	});

	it("rejects tool calls from branch summaries", async () => {
		const streamFn: StreamFn = () => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() =>
				stream.push({
					type: "done",
					reason: "toolUse",
					message: response([
						{ type: "toolCall", id: "tool-call-1", name: "read", arguments: { path: "README.md" } },
					]),
				}),
			);
			return stream;
		};

		const result = await generateBranchSummary(entries, {
			model,
			signal: new AbortController().signal,
			streamFn,
		});

		expect(result.error).toBe("Branch summarization attempted to call a tool");
	});

	it("rejects length-limited branch summaries", async () => {
		const streamFn: StreamFn = () => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() =>
				stream.push({
					type: "done",
					reason: "length",
					message: { ...response([{ type: "text", text: "partial" }]), stopReason: "length" },
				}),
			);
			return stream;
		};

		const result = await generateBranchSummary(entries, {
			model,
			signal: new AbortController().signal,
			streamFn,
		});

		expect(result.error).toBe(
			"Branch summarization failed: generation hit the token cap and the summary is incomplete",
		);
	});
});
