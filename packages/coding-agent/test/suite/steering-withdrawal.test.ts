import { Container, setKeybindings } from "@earendil-works/pi-tui";
import type { ResponsesClientEvent } from "openai/resources/responses/responses.js";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { streamSimple as streamCodex } from "../../../ai/src/api/openai-codex-responses.ts";
import { cleanupSessionResources } from "../../../ai/src/session-resources.ts";
import {
	createResponsesServer,
	type LocalResponsesRequest,
	replyWithOutput,
	textOutput,
} from "../../../ai/test/responses-websocket-server.ts";
import { TuiMainScreen } from "../../../tui/src/tui-main-screen.ts";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import type { AgentSessionEvent } from "../../src/core/agent-session.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { ChatContainer } from "../../src/modes/interactive/components/activity.ts";
import { CustomEditor } from "../../src/modes/interactive/components/custom-editor.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { getEditorTheme, getMarkdownTheme, initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { createHarness, getUserTexts } from "./harness.ts";

const token = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "local" } })).toString("base64url")}.x`;
afterEach(() => {
	cleanupSessionResources();
	vi.unstubAllGlobals();
});

it.each(["unsent", "unsent-normal", "accepted", "unacknowledged", "failed", "unknown"] as const)(
	"Alt+Up restores only recallable input (%s)",
	async (boundary) => {
		const unsent = boundary.startsWith("unsent");
		vi.stubGlobal("WebSocket", WebSocket);
		let parent: LocalResponsesRequest | undefined;
		let steers = 0;
		const fixture = await createResponsesServer((request) => {
			const body = request.body as ResponsesClientEvent;
			if (body.type === "response.steer") {
				steers++;
				if (boundary === "unacknowledged") return;
				request.send({
					type: "response.steer.accepted",
					steer: { id: `steer${steers}`, previous_response_id: "parent" },
				});
			} else if (!parent) {
				parent = request;
				request.send({ type: "response.created", response: { id: "parent", status: "in_progress" } });
			} else replyWithOutput(request, "recovery", [textOutput("recovery")]);
		});
		const h = await createHarness({
			tools: [],
			settings: { compaction: { enabled: false }, retry: { enabled: false } },
		});
		const session = h.session;
		const model = {
			...h.getModel(),
			api: "openai-codex-responses" as const,
			id: "gpt-6-astra",
			baseUrl: fixture.baseUrl,
			compat: { supportsSteering: true },
		};
		session.agent.state.model = model;
		let controlReady = false;
		session.agent.streamFunction = (_model, context, options) =>
			streamCodex(model, context, {
				...options,
				apiKey: token,
				transport: "auto",
				timeoutMs: 3000,
				onResponseControl(control) {
					options?.onResponseControl?.(control);
					controlReady = !!control;
				},
			});
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const prepare = session.agent.prepareSteering;
		session.agent.prepareSteering = async (message) => {
			if (unsent) await gate;
			await prepare?.(message);
		};
		initTheme("dark");
		const terminal = new VirtualTerminal(80, 24);
		const ui = new TuiMainScreen(terminal);
		const pending = new Container();
		ui.addChild(pending);
		const keys = new KeybindingsManager();
		setKeybindings(keys);
		const editor = new CustomEditor(ui, getEditorTheme(), keys);
		const view = Object.assign(Object.create(InteractiveMode.prototype), {
			runtimeHost: { session },
			editor,
			compactionQueuedMessages: [],
			isInitialized: true,
			ui,
			pendingMessagesContainer: pending,
			liveSteeringMessages: new Set(),
			chatContainer: new ChatContainer(),
			footer: { invalidate: vi.fn() },
			pendingTools: new Map(),
			completedToolCalls: new Set(),
			entriesRenderedByBoundaryCompaction: new Set(),
			workingVisible: false,
			clearStatusIndicator: vi.fn(),
			getMarkdownThemeWithSettings: getMarkdownTheme,
			getMarkdownTransformers: () => [],
			maybeSuggestBugReport: vi.fn(),
			showStatus: vi.fn(),
		}) as { handleDequeue(): void; handleEvent(event: AgentSessionEvent): Promise<void> };
		const unsubscribe = session.subscribe((event) => view.handleEvent(event));
		ui.start();
		editor.onAction("app.message.dequeue", () => view.handleDequeue());
		const run = session.prompt("original");
		try {
			await vi.waitFor(() => expect(controlReady).toBe(true));
			await session.steer("OLD");
			if (!unsent) await vi.waitFor(() => expect(steers).toBe(1));
			expect(session.getSteeringMessages()).toEqual(unsent ? ["OLD"] : []);
			for (const width of [80, 32]) {
				terminal.resize(width, 24);
				ui.requestRender(true);
				await terminal.waitForRender();
				const screen = terminal.getViewport().join("\n");
				expect(screen.match(/Steering: OLD/g)).toHaveLength(1);
				expect(screen.includes("to edit")).toBe(unsent);
			}
			expect(session.pendingMessageCount).toBe(unsent ? 1 : 0);
			expect(session.getCheckpointQueues().steering).toHaveLength(unsent ? 1 : 0);
			await vi.waitFor(() => expect(h.eventsOfType("queue_update").at(-1)?.steering).toEqual(unsent ? ["OLD"] : []));
			expect(h.eventsOfType("queue_update").filter((event) => event.steering.length === 0)).toHaveLength(
				unsent ? 0 : 1,
			);
			editor.handleInput("\u001b[1;3A");
			expect(editor.getText()).toBe(unsent ? "OLD" : "");
			editor.setText("");
			await session.followUp("LATER");
			await terminal.waitForRender();
			const mixed = terminal.getViewport().join("\n");
			expect(mixed).toContain("Follow-up: LATER");
			expect(mixed.includes("Steering: OLD")).toBe(!unsent);
			editor.handleInput("\u001b[1;3A");
			expect(editor.getText()).toBe("LATER");
			editor.setText("");
			editor.handleInput("NEW");
			await session.prompt(editor.getText(), { streamingBehavior: "steer" });
			editor.setText("");
			if (boundary === "unsent-normal") {
				parent!.send({
					type: "response.completed",
					response: {
						id: "parent",
						status: "completed",
						output: [],
						usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
					},
				});
				await vi.waitFor(() => expect(controlReady).toBe(false));
			}
			release();
			await vi.waitFor(() => expect(steers).toBe(boundary === "unsent-normal" ? 0 : unsent ? 1 : 2));
			if (boundary !== "unsent-normal") {
				parent!.send({
					type: "response.incomplete",
					response: {
						id: "parent",
						status: "incomplete",
						incomplete_details: { reason: "steered" },
						output: [],
						usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
					},
				});
				if (boundary === "unknown" || boundary === "unacknowledged") parent!.socket!.close(1000);
				else if (boundary === "failed") {
					for (let i = 1; i <= steers; i++)
						parent!.send({
							type: "response.steer.failed",
							steer: { id: `steer${i}`, previous_response_id: "parent" },
							error: { code: "successor_creation_failed", message: "fixture rejection" },
						});
				} else replyWithOutput(parent!, "successor", [textOutput("successor")]);
			}
			await run;
			expect(fixture.errors).toEqual([]);
			expect(getUserTexts(h)).toEqual(unsent ? ["original", "NEW"] : ["original", "OLD", "NEW"]);
			const sent = fixture.requests
				.map((request) => request.body as ResponsesClientEvent)
				.filter((body) => body.type === "response.steer")
				.map((body) => JSON.stringify(body.input));
			expect(sent.filter((input) => input.includes("OLD"))).toHaveLength(unsent ? 0 : 1);
			expect(sent.filter((input) => input.includes("NEW"))).toHaveLength(boundary === "unsent-normal" ? 0 : 1);
			const recovery = fixture.requests.filter((request) => request.body.type === "response.create")[1];
			if (recovery) {
				const replay = Array.isArray(recovery.body.input) ? recovery.body.input : [];
				for (const text of ["OLD", "NEW"])
					expect(
						replay.filter(
							(item) => "role" in item && item.role === "user" && JSON.stringify(item).includes(text),
						),
					).toHaveLength(unsent && text === "OLD" ? 0 : 1);
			}
			expect(session.clearQueue()).toEqual({ steering: [], followUp: [] });
			await terminal.waitForRender();
			expect(terminal.getViewport().join("\n")).not.toContain("Steering:");
		} finally {
			release();
			await session.abort();
			await run;
			unsubscribe();
			ui.stop();
			h.cleanup();
			await fixture.close();
		}
	},
);
