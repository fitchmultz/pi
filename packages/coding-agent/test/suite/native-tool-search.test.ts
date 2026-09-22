import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentTools,
	type ToolReference,
	type ToolResultMessage,
	toolId,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { readSessionCheckpoint, writeSessionCheckpoint } from "../../src/core/checkpoint.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

const left: ToolReference = { namespace: "left", name: "lookup" };
const right: ToolReference = { namespace: "right", name: "lookup" };
let harness: Harness | undefined;
afterEach(() => harness?.cleanup());

function registerLookup(pi: ExtensionAPI, reference: ToolReference, onExecute = () => {}) {
	pi.registerTool({
		...reference,
		label: "Lookup",
		description: reference.namespace ?? "bare",
		parameters: Type.Object({}),
		async execute() {
			onExecute();
			return { content: [{ type: "text", text: reference.namespace ?? "bare" }], details: {} };
		},
	});
}

describe("exact activation", () => {
	it("round-trips every public ID, clears the complete set, and never resolves a bare duplicate leaf", async () => {
		let api!: ExtensionAPI;
		harness = await createHarness({
			tools: [],
			extensionFactories: [
				(pi) => {
					api = pi;
					registerLookup(pi, left);
					registerLookup(pi, right);
				},
			],
		});
		expect(api.getActiveTools()).toEqual([toolId(left), toolId(right)]);
		expect(api.getAllTools().map(({ id, name, namespace }) => ({ id, name, namespace }))).toEqual([
			{ id: toolId(left), ...left },
			{ id: toolId(right), ...right },
		]);
		expect(harness.session.getToolDefinition("lookup")).toBeUndefined();
		expect(harness.session.getToolDefinition(right)?.namespace).toBe("right");
		expect(harness.session.getToolDefinition(toolId(left))?.namespace).toBe("left");
		api.setActiveTools([]);
		expect(api.getActiveToolReferences()).toEqual([]);
		api.setActiveTools(["lookup", "unknown"]);
		expect(api.getActiveTools()).toEqual([]);
		api.setActiveTools([toolId(right)]);
		expect(api.getActiveToolReferences()).toEqual([right]);
		api.setActiveToolReferences([left, right, left]);
		expect(api.getActiveTools()).toEqual([toolId(left), toolId(right)]);
	});

	it("keeps explicit allow/exclude scopes binding during activation and registration", async () => {
		let api!: ExtensionAPI;
		harness = await createHarness({
			tools: [],
			allowedToolNames: [left, right],
			excludedToolNames: [right],
			extensionFactories: [
				(pi) => {
					api = pi;
					registerLookup(pi, left);
					registerLookup(pi, right);
				},
			],
		});
		api.setActiveToolReferences([left, right]);
		expect(api.getActiveToolReferences()).toEqual([left]);
		api.setActiveTools([]);
		registerLookup(api, { name: "unrelated" });
		expect(api.getActiveTools()).toEqual([]);
		expect(api.getAllTools().map((tool) => tool.id)).toEqual([toolId(left)]);
	});

	it("does not widen a bare allowlist to namespaced same-name tools", async () => {
		harness = await createHarness({
			tools: [],
			allowedToolNames: ["lookup"],
			extensionFactories: [
				(pi) => {
					registerLookup(pi, left);
					registerLookup(pi, { name: "lookup" });
				},
			],
		});
		expect(harness.session.getAllTools().map((tool) => tool.id)).toEqual(["lookup"]);
	});

	it.each([false, true])("restores exact checkpoint IDs and reference restrictions (empty: %s)", async (empty) => {
		const directory = mkdtempSync(join(tmpdir(), "pi-namespace-checkpoint-"));
		try {
			harness = await createHarness({
				tools: [],
				allowedToolNames: [left, right],
				sessionManager: SessionManager.create(directory, join(directory, "sessions")),
				extensionFactories: [
					(pi) => {
						registerLookup(pi, left);
						registerLookup(pi, right);
					},
				],
			});
			const selected = empty ? [] : [right];
			harness.session.setActiveToolReferences(selected);
			const hold = await harness.session.acquireCheckpoint();
			try {
				const path = join(directory, "checkpoint.json");
				writeSessionCheckpoint(path, hold.checkpoint);
				const saved = readSessionCheckpoint(path);
				expect(saved.selection.activeTools).toEqual(selected.map(toolId));
				expect(saved.selection.knownTools).toEqual([toolId(left), toolId(right)]);
				expect(saved.toolConfiguration?.allowedToolNames).toEqual([left, right]);
				const { session } = await createAgentSession({
					checkpoint: saved,
					modelRuntime: harness.session.modelRuntime,
					resourceLoader: harness.session.resourceLoader,
					settingsManager: harness.settingsManager,
				});
				try {
					expect(session.getActiveToolReferences()).toEqual(selected);
					expect(session.getAllTools().map((tool) => tool.id)).toEqual([toolId(left), toolId(right)]);
				} finally {
					session.dispose();
				}
			} finally {
				hold.release();
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("rejects an ambiguous public ID without poisoning an existing registration", async () => {
		let api!: ExtensionAPI;
		harness = await createHarness({
			tools: [],
			extensionFactories: [
				(pi) => {
					api = pi;
					registerLookup(pi, left);
				},
			],
		});
		expect(() => registerLookup(api, { name: toolId(left) })).toThrow("Ambiguous public tool ID");
		expect(api.getActiveToolReferences()).toEqual([left]);
		registerLookup(api, right);
		expect(api.getActiveToolReferences()).toEqual([left, right]);
	});
});

it("registerToolSearch loads the exact permitted match through ordinary fallback and persists it", async () => {
	let called = 0;
	let api!: ExtensionAPI;
	harness = await createHarness({
		tools: [],
		extensionFactories: [
			(pi) => {
				api = pi;
				registerLookup(pi, left, () => {
					throw new Error("Wrong namespace");
				});
				registerLookup(pi, right, () => {
					called++;
				});
				pi.registerToolSearch({
					name: "discover",
					label: "Discover",
					description: "Find tools",
					parameters: Type.Object({ query: Type.String() }),
					async execute(_id, args) {
						expect(args.query).toBe("right");
						pi.setActiveToolReferences([...pi.getActiveToolReferences(), right]);
						return { content: [{ type: "text", text: "Loaded right.lookup" }], details: {}, tools: [right] };
					},
				});
			},
		],
	});
	api.setActiveTools(["discover"]);
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("discover", { query: "right" }), { stopReason: "toolUse" }),
		(context) => {
			const loaded = getCurrentTools(context.messages).find((tool) => tool.description === "right");
			expect(loaded).toBeDefined();
			return fauxAssistantMessage(fauxToolCall(loaded!.name, {}, { id: "right-call" }), { stopReason: "toolUse" });
		},
		fauxAssistantMessage("Done"),
	]);
	await harness.session.prompt("Find the right record");
	expect(called).toBe(1);
	const result = harness.session.messages.find(
		(message) => message.role === "toolResult" && message.toolName === "discover",
	);
	expect(result).toMatchObject({
		toolsAdded: [{ ...right, description: "right", parameters: { type: "object" } }],
		isError: false,
	});
	expect(
		harness.session.messages.find((message) => message.role === "toolResult" && message.toolCallId === "right-call"),
	).toMatchObject({ toolName: "lookup", namespace: "right" });
	expect(harness.eventsOfType("tool_execution_start").at(-1)).toMatchObject({
		toolName: "lookup",
		namespace: "right",
	});
});

it("folds retained search declarations at compaction without stripping fresh results", () => {
	const manager = SessionManager.inMemory();
	const leftTool = { ...left, description: "left", parameters: Type.Object({}) };
	const rightTool = { ...right, description: "right", parameters: Type.Object({}) };
	manager.appendMessage({ role: "system", content: "Base", toolsAdded: [leftTool], timestamp: 0 });
	const retained: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "old-search",
		toolName: "discover",
		toolCallKind: "toolSearch",
		toolsAdded: [rightTool],
		content: [],
		isError: false,
		timestamp: 1,
	};
	const kept = manager.appendMessage(retained);
	manager.appendMessage({ role: "system", content: "", toolsRemoved: [right], timestamp: 2 });
	manager.appendCompaction("summary", kept, 100);
	let messages = manager.buildSessionContext().messages;
	expect(getCurrentTools(messages)).toEqual([leftTool]);
	expect(messages.find((message) => message.role === "toolResult")).toMatchObject({ toolsAdded: undefined });
	const fresh = { ...retained, toolCallId: "fresh-search", timestamp: 3 };
	manager.appendMessage(fresh);
	messages = manager.buildSessionContext().messages;
	expect(getCurrentTools(messages)).toEqual([leftTool, rightTool]);
	expect(messages.find((message) => message.role === "toolResult" && message.toolCallId === "fresh-search")).toEqual(
		fresh,
	);
	expect(retained.toolsAdded).toEqual([rightTool]);
});

it.each([false, true])(
	"folds retained search state through ordinary context hooks and forced prompts (forced=%s)",
	async (forced) => {
		harness = await createHarness({
			tools: [],
			extensionFactories: [
				(pi) => {
					registerLookup(pi, left);
					registerLookup(pi, right);
					pi.on("context", (event) => ({
						messages: event.messages.filter((message) => message.role !== "system"),
					}));
					if (forced) pi.on("before_agent_start", () => ({ systemPrompt: "Forced instructions" }));
				},
			],
		});
		harness.session.setActiveToolReferences([left]);
		const leftTool = { ...left, description: "left", parameters: Type.Object({}) };
		const rightTool = { ...right, description: "right", parameters: Type.Object({}) };
		harness.sessionManager.appendMessage({ role: "system", content: "Base", toolsAdded: [leftTool], timestamp: 0 });
		harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "old-search",
			toolName: "discover",
			toolCallKind: "toolSearch",
			toolsAdded: [rightTool],
			content: [],
			isError: false,
			timestamp: 1,
		});
		harness.sessionManager.appendMessage({ role: "system", content: "", toolsRemoved: [right], timestamp: 2 });
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		let requested = false;
		harness.setResponses([
			(context) => {
				requested = true;
				expect(getCurrentTools(context.messages).map((tool) => tool.description)).toEqual(["left"]);
				expect(context.messages.find((message) => message.role === "toolResult")).not.toHaveProperty("toolsAdded");
				if (forced) expect(context.messages[0]).toMatchObject({ role: "system", content: "Forced instructions" });
				return fauxAssistantMessage("Done");
			},
		]);
		await harness.session.prompt("Continue");
		expect(requested).toBe(true);
		expect(
			harness.sessionManager
				.getEntries()
				.find((entry) => entry.type === "message" && entry.message.role === "toolResult"),
		).toMatchObject({ message: { toolsAdded: [rightTool] } });
	},
);

it("reports denied search references without publishing a declaration", async () => {
	harness = await createHarness({
		tools: [],
		allowedToolNames: ["discover"],
		extensionFactories: [
			(pi) => {
				registerLookup(pi, right);
				pi.registerToolSearch({
					name: "discover",
					label: "Discover",
					description: "Find tools",
					parameters: Type.Object({}),
					async execute() {
						pi.setActiveToolReferences([...pi.getActiveToolReferences(), right]);
						return { content: [], details: {}, tools: [right] };
					},
				});
			},
		],
	});
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("discover", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("Denied"),
	]);
	await harness.session.prompt("Find");
	const result = harness.session.messages.find((message) => message.role === "toolResult");
	expect(result).toMatchObject({
		isError: true,
		content: [{ text: expect.stringContaining("not active or permitted") }],
	});
	expect(result).not.toHaveProperty("toolsAdded");
	expect(harness.session.getActiveToolNames()).toEqual(["discover"]);
});
