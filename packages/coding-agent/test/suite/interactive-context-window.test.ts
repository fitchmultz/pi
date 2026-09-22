import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { expect, it, onTestFinished } from "vitest";
import type { AgentSessionEvent } from "../../src/core/agent-session.ts";
import type { StatusIndicator } from "../../src/modes/interactive/components/status-indicator.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

function createView(harness: Harness) {
	initTheme("dark", false);
	// Keep native session events and transcript components; omit terminal/editor setup.
	return Object.assign(Object.create(InteractiveMode.prototype), {
		runtimeHost: { session: harness.session },
		isInitialized: true,
		chatContainer: new Container(),
		pendingTools: new Map(),
		completedToolCalls: new Set(),
		defaultEditor: {},
		editor: { addToHistory() {} },
		footer: { invalidate() {} },
		ui: { requestRender() {}, terminal: { setProgress() {} } },
		compactView: true,
		hideThinkingBlock: true,
		outputPad: 1,
		hiddenThinkingLabel: "Thinking...",
		toolOutputExpanded: false,
		workingVisible: false,
		mermaidMarkdownTransformer: (text: string) => text,
		clearStatusIndicator() {},
		showStatusIndicator(indicator: StatusIndicator) {
			indicator.dispose();
		},
		async flushCompactionQueue() {},
		updatePendingMessagesDisplay() {},
		updateEditorBorderColor() {},
		renderProjectTrustWarningIfNeeded() {},
	}) as Pick<InteractiveMode, "renderInitialMessages"> & {
		chatContainer: Container;
		handleEvent(event: AgentSessionEvent): Promise<void>;
	};
}

it("replaces a live same-leaf renderer when the namespace arrives on toolcall_end", async () => {
	const harness = await createHarness({
		tools: [],
		extensionFactories: [
			(pi) => {
				for (const namespace of [undefined, "records"])
					pi.registerTool({
						name: "read",
						namespace,
						label: "Read",
						description: "Read",
						parameters: Type.Object({}),
						renderCall: () => new Text(namespace ? "records renderer" : "bare renderer", 0, 0),
						execute: async () => ({ content: [], details: {} }),
					});
			},
		],
	});
	onTestFinished(() => harness.cleanup());
	const view = createView(harness);
	const call = fauxToolCall("read", {}, { id: "late-identity" });
	const partial = fauxAssistantMessage(call, { stopReason: "pending" });
	await view.handleEvent({ type: "message_start", message: partial });
	await view.handleEvent({
		type: "message_update",
		message: partial,
		assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial },
	});
	expect(stripAnsi(view.chatContainer.render(120).join("\n"))).toContain("bare renderer");
	const finalCall = { ...call, namespace: "records" };
	const final = fauxAssistantMessage(finalCall, { stopReason: "toolUse" });
	await view.handleEvent({
		type: "message_update",
		message: final,
		assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: finalCall, partial: final },
	});
	const rendered = stripAnsi(view.chatContainer.render(120).join("\n"));
	expect(rendered).toContain("records renderer");
	expect(rendered).not.toContain("bare renderer");
});

it("previews only admitted arguments after preflight rewrites the target", async () => {
	let admit!: () => void;
	let entered!: () => void;
	const ready = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const barrier = new Promise<void>((resolve) => {
		admit = resolve;
	});
	const harness = await createHarness({
		tools: [],
		settings: { compaction: { enabled: false }, showCacheMissNotices: false },
		extensionFactories: [
			(pi) => {
				pi.on("tool_call", async (event) => {
					entered();
					await barrier;
					Object.assign(event.input, { path: "admitted-B" });
				});
				pi.registerTool({
					name: "edit",
					label: "Edit",
					description: "Edit",
					parameters: Type.Object({ path: Type.String() }),
					renderCall: (args, _theme, context) =>
						new Text(context.argsComplete ? `preview:${args.path}` : "waiting for admission", 0, 0),
					execute: async () => ({ content: [{ type: "text", text: "completed" }], details: {}, terminate: true }),
				});
			},
		],
	});
	onTestFinished(() => harness.cleanup());
	const view = createView(harness);
	const events: Promise<void>[] = [];
	harness.session.subscribe((event) => {
		events.push(view.handleEvent(event));
	});
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("edit", { path: "original-A" }), { stopReason: "toolUse" }),
	]);
	const run = harness.session.prompt("edit");
	await ready;
	expect(stripAnsi(view.chatContainer.render(120).join("\n"))).not.toContain("preview:original-A");
	admit();
	await run;
	await Promise.all(events);
	const rendered = stripAnsi(view.chatContainer.render(120).join("\n"));
	expect(rendered).toContain("preview:admitted-B");
	expect(rendered).not.toContain("preview:original-A");
});

it.each(["idle", "preflight", "tool batch", "automatic"])(
	"releases the previous native window on %s without losing history or pending inputs",
	async (boundary) => {
		const harness = await createHarness({
			tools: [],
			settings: { compaction: { enabled: false }, showCacheMissNotices: false },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_auto_compact", () => ({ newContext: { handoff: "next window" } }));
					pi.on("before_agent_start", (_event, ctx) => {
						if (boundary === "preflight") ctx.newContext({ handoff: "next window" });
					});
					pi.registerTool({
						name: "work",
						label: "Work",
						description: "Work locally",
						parameters: Type.Object({ reset: Type.Boolean() }),
						async execute(_id, args, _signal, onUpdate) {
							onUpdate?.({ content: [{ type: "text", text: "partial work" }], details: {} });
							return {
								content: [{ type: "text" as const, text: "completed work" }],
								details: {},
								...(args.reset ? { newContext: { handoff: "next window" } } : {}),
							};
						},
					});
				},
			],
		});
		onTestFinished(() => harness.cleanup());
		const oldAnswer = fauxAssistantMessage("Old transcript answer");
		harness.sessionManager.appendMessage({ role: "user", content: "Old transcript question", timestamp: 1 });
		harness.sessionManager.appendMessage(oldAnswer);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		const view = createView(harness);
		view.renderInitialMessages();
		const oldChildren = [...view.chatContainer.children];
		const events: Promise<void>[] = [];
		const renders: Array<{ event: AgentSessionEvent; output: string }> = [];
		harness.session.subscribe((event) => {
			events.push(view.handleEvent(event));
			renders.push({ event, output: stripAnsi(view.chatContainer.render(120).join("\n")) });
		});
		await harness.session.sendCustomMessage(
			{ customType: "aside", content: "pending aside", display: true },
			{ deliverAs: "nextTurn" },
		);

		if (boundary === "idle" || boundary === "automatic") {
			if (boundary === "idle") harness.session.newContext({ handoff: "next window" });
			else {
				const runAutoCompaction = Reflect.get(harness.session, "_runAutoCompaction") as (
					reason: "threshold",
					willRetry: boolean,
				) => Promise<boolean>;
				await runAutoCompaction.call(harness.session, "threshold", false);
			}
			expect(harness.session.pendingNextTurnCount).toBe(1);
		} else {
			const requests: string[][] = [];
			harness.setResponses([
				...(boundary === "tool batch"
					? [fauxAssistantMessage(fauxToolCall("work", { reset: true }), { stopReason: "toolUse" })]
					: []),
				(context) => {
					requests.push(context.messages.filter((message) => message.role !== "system").map(getMessageText));
					return fauxAssistantMessage(fauxToolCall("work", { reset: false }), { stopReason: "toolUse" });
				},
				fauxAssistantMessage("current answer"),
			]);
			await harness.session.prompt("current question");
			if (boundary === "preflight") {
				expect(requests[0]).toEqual([expect.stringContaining("next window"), "current question", "pending aside"]);
			}
		}
		await Promise.all(events);

		const output = stripAnsi(view.chatContainer.render(120).join("\n"));
		expect(output).not.toContain("Old transcript answer");
		for (const component of oldChildren) expect(view.chatContainer.children).not.toContain(component);
		expect(output.match(/Handoff from the previous window:/g)).toHaveLength(1);
		expect(harness.sessionManager.getBranch()).toContainEqual(expect.objectContaining({ message: oldAnswer }));
		expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "context_window")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end")).toHaveLength(boundary === "automatic" ? 1 : 0);
		expect(harness.eventsOfType("context_window_started")).toHaveLength(1);
		for (const type of ["message_start", "message_end"] as const) {
			expect(
				harness
					.eventsOfType(type)
					.filter((event) => event.message.role === "custom" && event.message.customType === "context-window"),
			).toHaveLength(1);
		}
		if (boundary === "preflight" || boundary === "tool batch") {
			expect(output).toContain("completed work");
			expect(output).toContain("current answer");
			expect(
				renders
					.filter(({ event }) => event.type === "tool_execution_update")
					.every(({ output }) => output.includes("partial work")),
			).toBe(true);
			if (boundary === "preflight") {
				expect(output.match(/current question/g)).toHaveLength(1);
				expect(output.match(/pending aside/g)).toHaveLength(1);
			}
		}
		const reloaded = createView(harness);
		reloaded.renderInitialMessages();
		expect(view.chatContainer.render(120)).toEqual(reloaded.chatContainer.render(120));
	},
);
