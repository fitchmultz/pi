import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Model,
	type SimpleStreamOptions,
	type SystemMessage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { generateBranchSummary, prepareBranchEntries, serializeConversation } from "../src/core/compaction/index.ts";
import { convertToLlm } from "../src/core/messages.ts";
import { type SessionEntry, SessionManager } from "../src/core/session-manager.ts";

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

const entries: SessionEntry[] = [
	{
		type: "message",
		id: "branch-user",
		parentId: null,
		timestamp: new Date(1).toISOString(),
		message: { role: "user", content: "Abandoned request", timestamp: 1 },
	},
];

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
	// PR50: prompt/tool state omitted by serialization must not crowd out conversation.
	it.each<{ name: string; patch: SystemMessage }>([
		{ name: "instructions", patch: { role: "system", content: "p".repeat(68_000), timestamp: 2 } },
		{
			name: "prompt sections",
			patch: { role: "system", content: "", sections: { project_context: "p".repeat(68_000) }, timestamp: 2 },
		},
		{
			name: "tool declarations",
			patch: {
				role: "system",
				content: "",
				toolsAdded: [{ name: "extension_tool", description: "p".repeat(68_000), parameters: Type.Object({}) }],
				toolsRemoved: [{ name: "old_extension_tool" }],
				timestamp: 2,
			},
		},
	])("does not spend the conversation budget on $name", async ({ patch }) => {
		const session = SessionManager.inMemory();
		const earlier = { role: "user" as const, content: "Deploy needs owner approval", timestamp: 1 };
		const recent = { role: "user" as const, content: "Please continue.", timestamp: 3 };
		session.appendMessage(earlier);
		session.appendMessage(patch);
		session.appendMessage(recent);
		const branch = session.getBranch();
		const control = prepareBranchEntries(
			branch.filter((entry) => entry.type !== "message" || entry.message.role !== "system"),
			16384,
		);
		expect(control.messages).toEqual([earlier, recent]);
		expect(control.totalTokens).toBeLessThan(16384);
		const conversation = serializeConversation(convertToLlm([earlier, patch, recent]));
		expect(conversation).toBe(serializeConversation(convertToLlm(control.messages)));

		for (const budget of [16384, 0]) {
			const prepared = prepareBranchEntries(branch, budget);
			expect(prepared.messages).toEqual(control.messages);
			expect(prepared.totalTokens).toBe(control.totalTokens);
		}

		let requests = 0;
		const result = await generateBranchSummary(branch, {
			model: { ...model, contextWindow: 32768 },
			signal: new AbortController().signal,
			streamFn: (_model, context) => {
				requests++;
				const request = serializeConversation(context.messages);
				expect(request).toContain(`<conversation>\n${conversation}\n</conversation>`);
				expect(request).not.toContain("p".repeat(100));
				const stream = createAssistantMessageEventStream();
				stream.push({ type: "done", reason: "stop", message: response([{ type: "text", text: earlier.content }]) });
				return stream;
			},
		});
		expect(requests).toBe(1);
		expect(result.summary).toContain(earlier.content);
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
