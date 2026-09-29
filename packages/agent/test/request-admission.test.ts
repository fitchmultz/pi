import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Model,
	normalizeContext,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { Agent } from "../src/agent.ts";
import type { AgentMessage } from "../src/types.ts";

const model: Model<"openai-responses"> = {
	id: "offline",
	name: "Offline",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://offline.invalid",
	reasoning: false,
	input: ["text"],
	contextWindow: 10000,
	maxTokens: 1000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function response() {
	const stream = createAssistantMessageEventStream();
	stream.push({ type: "done", reason: "stop", message: fauxAssistantMessage("done") });
	return stream;
}

describe("request-boundary admission", () => {
	it.each(["prepare", "transform", "auth"])("never dispatches after cancellation during %s", async (stage) => {
		const streamFn = vi.fn(response);
		const agent = new Agent({ initialState: { model }, streamFn });
		if (stage === "prepare")
			agent.prepareRequest = async () => {
				agent.abort();
			};
		if (stage === "transform")
			agent.transformContext = async (messages) => {
				agent.abort();
				return messages;
			};
		if (stage === "auth")
			agent.getApiKey = async () => {
				agent.abort();
				return "unused";
			};
		await agent.prompt("hello");
		expect(streamFn).not.toHaveBeenCalled();
		expect(agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
		expect(agent.state.isStreaming).toBe(false);
	});

	it("closes host-owned and conversational requests without recording a phantom assistant failure", async () => {
		const streamFn = vi.fn(response);
		const admission = new AbortController();
		const agent = new Agent({ initialState: { model }, streamFn });
		agent.requestAdmissionSignal = admission.signal;
		agent.getApiKey = async () => {
			admission.abort(new Error("shutdown"));
			return "unused";
		};
		await agent.prompt("retained input");
		expect(streamFn).not.toHaveBeenCalled();
		expect(agent.state.messages).toMatchObject([{ role: "user", content: [{ text: "retained input" }] }]);
		expect(() => agent.streamResponse(model, normalizeContext({ messages: [] }))).toThrow("shutdown");
	});

	it("does not consume queued input when an agent_start listener cancels preparation", async () => {
		const streamFn = vi.fn(response);
		const agent = new Agent({ initialState: { model }, streamFn });
		const queued: AgentMessage = { role: "user", content: "later", timestamp: 1 };
		agent.steer(queued);
		agent.followUp(queued);
		agent.subscribe((event) => {
			if (event.type === "agent_start") agent.abort();
		});
		await agent.prompt("hello");
		expect(streamFn).not.toHaveBeenCalled();
		expect(agent.getQueuedMessages()).toEqual({ steering: [queued], followUp: [queued] });
	});

	it("keeps queued input when cancellation ends a completed turn", async () => {
		const agent = new Agent({ initialState: { model }, streamFn: response });
		const queued: AgentMessage = { role: "user", content: "next", timestamp: 1 };
		agent.finishTurn = async () => {
			agent.steer(queued);
			agent.abort();
		};
		await agent.prompt("hello");
		expect(agent.getQueuedMessages().steering).toEqual([queued]);
		expect(agent.state.messages).not.toContain(queued);
	});

	it("snapshots all queued images and selectively removes input without changing queue modes or identities", () => {
		const agent = new Agent({ initialState: { model }, streamFn: response });
		const image: AgentMessage = {
			role: "user",
			content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
			timestamp: 1,
		};
		const retained: AgentMessage = { role: "user", content: "keep", timestamp: 2 };
		agent.steer(image);
		agent.steer(retained);
		agent.followUp(image);
		const snapshot = agent.getQueuedMessages();
		expect(snapshot.steering).toEqual([image, retained]);
		snapshot.steering.pop();
		expect(agent.getQueuedMessages().steering).toHaveLength(2);
		expect(agent.takeQueuedMessages((message) => message === image)).toEqual([image, image]);
		expect(agent.peekQueuedMessages()[0]).toBe(retained);
		expect(agent.hasQueuedSteeringMessages()).toBe(true);
		expect(agent.steeringMode).toBe("one-at-a-time");
	});
});
