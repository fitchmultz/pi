import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionShutdownEvent } from "../src/index.ts";
import { runPrintMode } from "../src/modes/print-mode.ts";

type EmitEvent = SessionShutdownEvent;

type FakeExtensionRunner = {
	hasHandlers: (eventType: string) => boolean;
	emit: ReturnType<typeof vi.fn<(event: EmitEvent) => Promise<void>>>;
};

type FakeSession = {
	sessionManager: { getHeader: () => object | undefined };
	agent: { waitForIdle: () => Promise<void>; subscribe: ReturnType<typeof vi.fn> };
	state: { messages: AgentMessage[] };
	extensionRunner: FakeExtensionRunner;
	bindExtensions: ReturnType<typeof vi.fn>;
	subscribe: ReturnType<typeof vi.fn>;
	prompt: ReturnType<typeof vi.fn>;
	reload: ReturnType<typeof vi.fn>;
};

type FakeRuntimeHost = {
	session: FakeSession;
	newSession: ReturnType<typeof vi.fn>;
	fork: ReturnType<typeof vi.fn>;
	switchSession: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
	setRebindSession: ReturnType<typeof vi.fn>;
};

function createAssistantMessage(options?: {
	text?: string;
	stopReason?: AssistantMessage["stopReason"];
	errorMessage?: string;
}): AssistantMessage {
	return {
		role: "assistant",
		content: options?.text ? [{ type: "text", text: options.text }] : [],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: options?.stopReason ?? "stop",
		errorMessage: options?.errorMessage,
		timestamp: Date.now(),
	};
}

function captureMessages(session: FakeSession): (message: AgentMessage) => void {
	let listener: ((event: { type: "message_end"; message: AgentMessage }) => void) | undefined;
	session.subscribe.mockImplementation((next) => {
		listener = next;
		return () => {};
	});
	return (message) => listener?.({ type: "message_end", message });
}

const contextWindowMarker: AgentMessage = {
	role: "custom",
	customType: "context-window",
	content: "Fresh context window",
	display: true,
	details: { windowId: "window-2" },
	timestamp: Date.now(),
};

function createRuntimeHost(assistantMessage: AssistantMessage): FakeRuntimeHost {
	const extensionRunner: FakeExtensionRunner = {
		hasHandlers: (eventType: string) => eventType === "session_shutdown",
		emit: vi.fn(async () => {}),
	};

	const state = { messages: [assistantMessage] };

	const session: FakeSession = {
		sessionManager: { getHeader: () => undefined },
		agent: { waitForIdle: async () => {}, subscribe: vi.fn(() => () => {}) },
		state,
		extensionRunner,
		bindExtensions: vi.fn(async () => {}),
		subscribe: vi.fn(() => () => {}),
		prompt: vi.fn(async () => {}),
		reload: vi.fn(async () => {}),
	};

	return {
		session,
		newSession: vi.fn(async () => undefined),
		fork: vi.fn(async () => ({ selectedText: "" })),
		switchSession: vi.fn(async () => undefined),
		dispose: vi.fn(async () => {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		}),
		setRebindSession: vi.fn(),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("runPrintMode", () => {
	it("emits session_shutdown in text mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;
		const images: ImageContent[] = [{ type: "image", mimeType: "image/png", data: "abc" }];

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "Say done",
			initialImages: images,
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith("Say done", { images });
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("prints the completed response when context follows a native reset", async () => {
		const assistantMessage = createAssistantMessage({ text: "done" });
		const runtimeHost = createRuntimeHost(assistantMessage);
		const { session } = runtimeHost;
		const emitMessage = captureMessages(session);
		session.prompt.mockImplementation(async () => {
			emitMessage(assistantMessage);
			emitMessage(contextWindowMarker);
			session.state.messages = [
				contextWindowMarker,
				{
					role: "custom",
					customType: "after-end",
					content: "extra context",
					display: false,
					timestamp: Date.now(),
				},
			];
		});
		const stdout = vi.spyOn(process.stdout, "write");

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "Say done",
		});

		expect(exitCode).toBe(0);
		expect(stdout).toHaveBeenCalledWith("done\n", expect.any(Function));
	});

	it("prefers the branch selected by a later print-mode prompt", async () => {
		const selectedBranch = createAssistantMessage({ text: "selected branch" });
		const laterBranch = createAssistantMessage({ text: "later branch" });
		const runtimeHost = createRuntimeHost(selectedBranch);
		const { session } = runtimeHost;
		const emitMessage = captureMessages(session);
		let promptCount = 0;
		session.prompt.mockImplementation(async () => {
			if (promptCount++ === 0) {
				emitMessage(laterBranch);
				session.state.messages = [laterBranch];
			} else {
				session.state.messages = [selectedBranch];
			}
		});
		const stdout = vi.spyOn(process.stdout, "write");

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "Generate on this branch",
			messages: ["/tree select earlier branch"],
		});

		expect(exitCode).toBe(0);
		expect(stdout).toHaveBeenCalledWith("selected branch\n", expect.any(Function));
		expect(stdout).not.toHaveBeenCalledWith("later branch\n", expect.any(Function));
	});

	it("does not reuse an earlier response when a later prompt starts a new context", async () => {
		const earlier = createAssistantMessage({ text: "earlier response" });
		const runtimeHost = createRuntimeHost(earlier);
		const { session } = runtimeHost;
		const emitMessage = captureMessages(session);
		let promptCount = 0;
		session.prompt.mockImplementation(async () => {
			if (promptCount++ === 0) {
				emitMessage(earlier);
				session.state.messages = [earlier];
			} else {
				session.state.messages = [contextWindowMarker];
			}
		});
		const stdout = vi.spyOn(process.stdout, "write");

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "Generate",
			messages: ["Start a new context without an assistant response"],
		});

		expect(exitCode).toBe(0);
		expect(stdout).not.toHaveBeenCalledWith("earlier response\n", expect.any(Function));
	});

	it("does not print an intermediate assistant after a reset when a terminating tool leaves the branch tip", async () => {
		const intermediate = createAssistantMessage({ text: "intermediate preamble", stopReason: "toolUse" });
		const runtimeHost = createRuntimeHost(intermediate);
		const { session } = runtimeHost;
		const emitMessage = captureMessages(session);
		session.prompt.mockImplementation(async () => {
			emitMessage(contextWindowMarker);
			emitMessage(intermediate);
			session.state.messages = [
				contextWindowMarker,
				intermediate,
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "stop",
					content: [{ type: "text", text: "stopped" }],
					isError: false,
					timestamp: Date.now(),
				},
			];
		});
		const stdout = vi.spyOn(process.stdout, "write");

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "Stop through the tool",
		});

		expect(exitCode).toBe(0);
		expect(stdout).not.toHaveBeenCalledWith("intermediate preamble\n", expect.any(Function));
	});

	it("emits session_shutdown in json mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			messages: ["hello"],
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith("hello");
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("emits session_shutdown and returns non-zero on assistant error", async () => {
		const runtimeHost = createRuntimeHost(
			createAssistantMessage({ stopReason: "error", errorMessage: "provider failure" }),
		);
		const { session } = runtimeHost;
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});

		expect(exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith("provider failure");
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});
});
