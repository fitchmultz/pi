import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type TextContent } from "@earendil-works/pi-ai";
import type { ClassifierModel, ToolResultMessage, Usage } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackgroundToolMessageDetails, ExtensionAPI, ToolDefinition } from "../../src/core/extensions/types.ts";
import type { CustomMessage } from "../../src/core/messages.ts";
import type { CustomEntry } from "../../src/core/session-manager.ts";
import { createToolDefinitionFromAgentTool } from "../../src/core/tools/tool-definition-wrapper.ts";
import { getUsageCostBreakdown } from "../../src/core/usage-totals.ts";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import {
	CODEMODE_BACKGROUND_COMPLETION_TYPE,
	CODEMODE_STORE_ENTRY_TYPE,
	type CodemodeToolDetails,
} from "../../src/extensions/codemode/tool.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

const BACKGROUND = '// @options: {"background": true}\n';

function usage(input: number, cost: number): Usage {
	return {
		input,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input,
		cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

interface GatedTool {
	tool: AgentTool;
	started: Promise<void>;
	release: () => void;
	starts: () => number;
	aborted: () => boolean;
}

function createGatedTool(name = "gated", toolUsage?: Usage): GatedTool {
	const started = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	let starts = 0;
	let aborted = false;
	const tool: AgentTool = {
		name,
		label: name,
		description: `Waits for ${name}`,
		parameters: Type.Object({}),
		execute: async (_id, _params, signal) => {
			starts++;
			started.resolve();
			if (signal?.aborted) aborted = true;
			await Promise.race([
				released.promise,
				new Promise<never>((_resolve, reject) => {
					signal?.addEventListener(
						"abort",
						() => {
							aborted = true;
							reject(new Error(`${name} aborted`));
						},
						{ once: true },
					);
				}),
			]);
			return {
				content: [{ type: "text", text: `${name} ran` }],
				details: {},
				...(toolUsage ? { usage: toolUsage } : {}),
			};
		},
	};
	return { tool, started: started.promise, release: released.resolve, starts: () => starts, aborted: () => aborted };
}

/** A tool whose background work waits for the test, so a run settles at a chosen moment. */
function createDeferredRunTool(toolUsage?: Usage) {
	const started = Promise.withResolvers<void>();
	const finished = Promise.withResolvers<void>();
	let runId: string | undefined;
	const tool: ToolDefinition = {
		name: "deferred_run",
		label: "deferred_run",
		description: "Starts a background run the test finishes",
		parameters: Type.Object({}),
		execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
			runId = ctx.runInBackground("test-background", async () => {
				started.resolve();
				await finished.promise;
				return {
					content: [{ type: "text", text: "work output" }],
					details: undefined,
					...(toolUsage ? { usage: toolUsage } : {}),
				};
			});
			return { content: [{ type: "text", text: "started" }], details: undefined };
		},
	};
	return { tool, started: started.promise, finish: finished.resolve, runId: () => runId };
}

/** A background run that attempts a nested call when the test allows it. */
function createHoldAttemptTool(toolUsage?: Usage) {
	const started = Promise.withResolvers<void>();
	const attempt = Promise.withResolvers<void>();
	const attempted = Promise.withResolvers<void>();
	let runId: string | undefined;
	let commits = 0;
	const tool: ToolDefinition = {
		name: "hold_attempt",
		label: "hold_attempt",
		description: "Attempts a nested call when the test allows it",
		parameters: Type.Object({}),
		execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
			runId = ctx.runInBackground("test-background", async () => {
				started.resolve();
				await attempt.promise;
				attempted.resolve();
				const outcome = await ctx.executeTool("second", {});
				return {
					content: outcome.result.content,
					details: undefined,
					...(toolUsage ? { usage: toolUsage } : {}),
					commit: () => {
						commits++;
					},
				};
			});
			return { content: [{ type: "text", text: "started" }], details: undefined };
		},
	};
	return {
		tool,
		started: started.promise,
		attempt: attempt.resolve,
		attempted: attempted.promise,
		commits: () => commits,
		runId: () => runId,
	};
}

/** A 1x1 red 24bpp BMP, which normalization converts to PNG. */
function createTinyBmp(): string {
	const buffer = Buffer.alloc(58);
	buffer.write("BM", 0, "ascii");
	buffer.writeUInt32LE(buffer.length, 2);
	buffer.writeUInt32LE(54, 10);
	buffer.writeUInt32LE(40, 14);
	buffer.writeInt32LE(1, 18);
	buffer.writeInt32LE(1, 22);
	buffer.writeUInt16LE(1, 26);
	buffer.writeUInt16LE(24, 28);
	buffer.writeUInt32LE(0, 30);
	buffer.writeUInt32LE(4, 34);
	buffer[56] = 0xff;
	return buffer.toString("base64");
}

const toolExtension = (tool: ToolDefinition) => (pi: ExtensionAPI) => pi.registerTool(tool);

const resultText = (result: { content: Array<{ type: string; text?: string }> }): string =>
	result.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");

const codemodeResult = (harness: Harness): ToolResultMessage => {
	const result = harness.session.messages.findLast(
		(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "codemode",
	);
	if (!result) throw new Error("No codemode tool result");
	return result;
};

const completions = (
	harness: Harness,
	customType = CODEMODE_BACKGROUND_COMPLETION_TYPE,
): CustomMessage<BackgroundToolMessageDetails<CodemodeToolDetails>>[] =>
	harness.session.messages.filter(
		(message): message is CustomMessage<BackgroundToolMessageDetails<CodemodeToolDetails>> =>
			message.role === "custom" && message.customType === customType,
	);

const usageEntries = (harness: Harness) =>
	harness.sessionManager.getEntries().filter((entry) => entry.type === "usage");

const storeEntries = (harness: Harness): unknown[] =>
	harness.sessionManager
		.getBranch()
		.filter(
			(entry): entry is CustomEntry => entry.type === "custom" && entry.customType === CODEMODE_STORE_ENTRY_TYPE,
		)
		.map((entry) => entry.data);

const messageText = (message: { content: string | Array<{ type: string; text?: string }> }): string =>
	typeof message.content === "string" ? message.content : resultText({ content: message.content });

async function waitForCompletion(
	harness: Harness,
	customType = CODEMODE_BACKGROUND_COMPLETION_TYPE,
): Promise<CustomMessage<BackgroundToolMessageDetails<CodemodeToolDetails>>> {
	await vi.waitFor(() => expect(completions(harness, customType)).toHaveLength(1));
	return completions(harness, customType)[0]!;
}

/** The completion's own blocks, without the `Background run <id> completed.` line the session adds. */
const completionText = (message: CustomMessage<unknown>): string => {
	const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
	return blocks
		.slice(1)
		.map((block) => (block.type === "text" ? block.text : `<${block.type}>`))
		.join("");
};

/** Let the session run its pending microtasks and the work's promise chain. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("codemode background runs", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup(
		tools: AgentTool[] = [],
		extensionFactories: NonNullable<HarnessOptions["extensionFactories"]> = [],
		provider?: string,
	) {
		const registerTools = (pi: ExtensionAPI) => {
			for (const tool of tools) pi.registerTool(createToolDefinitionFromAgentTool(tool));
		};
		const harness = await createHarness({
			provider,
			initialActiveToolNames: ["codemode"],
			extensionFactories: [createCodemodeExtension(), registerTools, ...extensionFactories],
		});
		harnesses.push(harness);
		return harness;
	}

	async function launch(
		harness: Harness,
		code: string,
		responses: string[] = ["foreground done", "after completion"],
	) {
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("codemode", { code })], { stopReason: "toolUse" }),
			...responses.map((text) => fauxAssistantMessage(text)),
		]);
		await harness.session.prompt("go");
	}

	async function promptTool(harness: Harness, name: string, responses: string[] = ["foreground done"]) {
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(name, {})], { stopReason: "toolUse" }),
			...responses.map((text) => fauxAssistantMessage(text)),
		]);
		await harness.session.prompt("go");
	}

	// #11184: the process-wide native admission queue also owns detached scripts. These tests use
	// real sandbox workers and real session tool calls; only the nested tools wait for test input.
	it("queues background and foreground scripts across sessions in one FIFO, retaining receipts and save blockers", async () => {
		vi.stubEnv("PI_CODEMODE_MAX_WORKERS", "1");
		const first = createGatedTool("first");
		const second = createGatedTool("second", usage(23, 0.23));
		const third = createGatedTool("third");
		const resident = await setup([first.tool], [], "codemode-resident");
		const background = await setup([second.tool], [], "codemode-background");
		const foreground = await setup([third.tool], [], "codemode-foreground");
		let foregroundRun: Promise<void> | undefined;
		try {
			await launch(resident, `${BACKGROUND}await tools.first({}); return "first";`);
			await first.started;
			await launch(
				background,
				`${BACKGROUND}await tools.second({}); store("step", load("queued")); return load("queued");`,
			);
			const receipt = codemodeResult(background);
			expect(receipt.details).toEqual({ calls: [], background: { runId: receipt.toolCallId } });
			expect(background.session.getLastAssistantText()).toBe("foreground done");
			expect(second.starts()).toBe(0);
			expect(completions(background)).toHaveLength(0);
			// The store belongs to the script's actual execution, not its earlier queue admission.
			background.sessionManager.appendCustomEntry(CODEMODE_STORE_ENTRY_TYPE, { set: { queued: 99 }, delete: [] });

			const queuedForeground = Promise.withResolvers<void>();
			const unsubscribe = foreground.session.subscribe((event) => {
				if (event.type === "tool_execution_update" && event.toolName === "codemode") queuedForeground.resolve();
			});
			foregroundRun = launch(foreground, 'await tools.third({}); return "third";', ["foreground finished"]);
			await queuedForeground.promise;
			unsubscribe();
			await flush();
			expect(third.starts()).toBe(0);

			const hold = await background.session.acquireWorkingSession();
			// Observe the native hold barrier without replacing its implementation or worker scheduling.
			const waitingForRelease = vi.spyOn(background.session.workingSessionGate, "waitForRelease");
			try {
				expect(hold.sleepReady).toBe(false);
				expect(hold.blockers).toContain(`Background run ${receipt.toolCallId} is active`);
				first.release();
				await waitForCompletion(resident);
				// Completion can precede actual worker exit. Wait until the next real worker has started
				// its nested call and reached this session's hold barrier before checking parked state.
				await vi.waitFor(() => expect(waitingForRelease).toHaveBeenCalledTimes(1));
				expect(hold.invalidated.aborted).toBe(false);
				expect(second.starts()).toBe(0);
				expect(third.starts()).toBe(0);
				expect(storeEntries(background)).toEqual([{ set: { queued: 99 }, delete: [] }]);
				expect(usageEntries(background)).toHaveLength(0);
				expect(completions(background)).toHaveLength(0);
			} finally {
				waitingForRelease.mockRestore();
				await hold.release();
			}
			await second.started;
			expect(third.starts()).toBe(0);
			second.release();
			const completion = await waitForCompletion(background);
			expect(completionText(completion)).toMatch(/Output:\n99$/);
			expect(completion.details?.nestedCalls?.calls.map((call) => [call.name, call.status])).toEqual([
				["second", "ok"],
			]);
			expect(usageEntries(background)).toHaveLength(1);
			expect(storeEntries(background)).toEqual([
				{ set: { queued: 99 }, delete: [] },
				{ set: { step: 99 }, delete: [] },
			]);
			await third.started;
			third.release();
			await foregroundRun;
			expect(resultText(codemodeResult(foreground))).toMatch(/Output:\n\nthird$/);
			await background.session.waitForIdle();
			expect(completions(background)).toHaveLength(1);
			const entries = background.sessionManager.getEntries();
			expect(
				entries.findIndex(
					(entry) => entry.type === "custom_message" && entry.customType === CODEMODE_BACKGROUND_COMPLETION_TYPE,
				),
			).toBeGreaterThan(
				entries.findIndex(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "toolResult" &&
						entry.message.toolCallId === receipt.toolCallId,
				),
			);
		} finally {
			first.release();
			second.release();
			third.release();
			await Promise.all([resident.session.abort(), background.session.abort(), foreground.session.abort()]);
			await foregroundRun;
			vi.unstubAllEnvs();
		}
	});

	it("aborts a queued background script without starting tools or committing, and admits later work", async () => {
		vi.stubEnv("PI_CODEMODE_MAX_WORKERS", "1");
		const first = createGatedTool("first");
		const queued = createGatedTool("queued");
		const resident = await setup([first.tool], [], "codemode-abort-resident");
		const background = await setup([queued.tool], [], "codemode-abort-waiter");
		try {
			await launch(resident, `${BACKGROUND}await tools.first({});`);
			await first.started;
			await launch(background, `${BACKGROUND}await tools.queued({}); store("step", 1);`);
			expect(codemodeResult(background).details).toMatchObject({ background: { runId: expect.any(String) } });
			await background.session.abort();
			expect(queued.starts()).toBe(0);
			expect(completions(background)).toHaveLength(0);
			expect(storeEntries(background)).toHaveLength(0);
			expect(usageEntries(background)).toHaveLength(0);
			const hold = await background.session.acquireWorkingSession();
			try {
				expect(hold.sleepReady).toBe(true);
			} finally {
				await hold.release();
			}
			first.release();
			await waitForCompletion(resident);
			expect(queued.starts()).toBe(0);
			queued.release();
			await launch(background, `${BACKGROUND}await tools.queued({}); store("step", 2);`);
			await waitForCompletion(background);
			expect(queued.starts()).toBe(1);
			expect(storeEntries(background)).toEqual([{ set: { step: 2 }, delete: [] }]);
		} finally {
			first.release();
			queued.release();
			await Promise.all([resident.session.abort(), background.session.abort()]);
			vi.unstubAllEnvs();
		}
	});

	it("delivers one queued background timeout after its receipt without store writes or nested calls", async () => {
		vi.stubEnv("PI_CODEMODE_MAX_WORKERS", "1");
		const first = createGatedTool("first");
		const queued = createGatedTool("queued");
		const resident = await setup([first.tool], [], "codemode-timeout-resident");
		const background = await setup([queued.tool], [], "codemode-timeout-waiter");
		try {
			await launch(resident, `${BACKGROUND}await tools.first({});`);
			await first.started;
			await launch(
				background,
				'// @options: {"background": true, "timeout_ms": 50}\nawait tools.queued({}); store("step", 1);',
			);
			const receipt = codemodeResult(background);
			expect(receipt.isError).toBe(false);
			const completion = await waitForCompletion(background);
			expect(completion.details?.runId).toBe(receipt.toolCallId);
			expect(completion.details?.isError).toBe(true);
			expect(completionText(completion)).toContain(
				"Execution timed out after 50 ms while waiting for a free codemode worker",
			);
			expect(completionText(completion)).toContain("The script did not start.");
			expect(queued.starts()).toBe(0);
			expect(storeEntries(background)).toHaveLength(0);
			expect(usageEntries(background)).toHaveLength(0);
			expect(completion.details?.resultDetails?.calls).toEqual([]);
			first.release();
			await waitForCompletion(resident);
			await background.session.waitForIdle();
			expect(queued.starts()).toBe(0);
			expect(completions(background)).toHaveLength(1);
			const entries = background.sessionManager.getEntries();
			expect(
				entries.findIndex(
					(entry) => entry.type === "custom_message" && entry.customType === CODEMODE_BACKGROUND_COMPLETION_TYPE,
				),
			).toBeGreaterThan(
				entries.findIndex(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "toolResult" &&
						entry.message.toolCallId === receipt.toolCallId,
				),
			);
		} finally {
			first.release();
			queued.release();
			await Promise.all([resident.session.abort(), background.session.abort()]);
			vi.unstubAllEnvs();
		}
	});

	it("returns a receipt, keeps the foreground turn going, and delivers the result once with its usage", async () => {
		const gate = createGatedTool("gated", usage(100, 0.25));
		const harness = await setup([gate.tool]);
		await launch(harness, `${BACKGROUND}await tools.gated({});\nstore("step", 1);\nreturn "script output";`);

		const receipt = codemodeResult(harness);
		await gate.started;
		expect(gate.starts()).toBe(1);
		expect(receipt.content).toEqual([
			{
				type: "text",
				text: `Script running in background.\nRun ${receipt.toolCallId}. Its result arrives as a message when the script finishes.`,
			},
		]);
		expect(receipt.isError).toBe(false);
		expect(receipt.usage).toBeUndefined();
		expect(receipt.nestedCalls).toBeUndefined();
		expect(receipt.details).toEqual({ calls: [], background: { runId: receipt.toolCallId } });
		expect(harness.session.getLastAssistantText()).toBe("foreground done");
		expect(completions(harness)).toHaveLength(0);
		expect(usageEntries(harness)).toHaveLength(0);
		expect(storeEntries(harness)).toHaveLength(0);

		gate.release();
		const completion = await waitForCompletion(harness);
		expect(completion.details?.runId).toBe(receipt.toolCallId);
		expect(completion.details?.isError).toBe(false);
		expect(completion.content[0]).toEqual({
			type: "text",
			text: `Background run ${receipt.toolCallId} completed.\n`,
		});
		expect(completionText(completion)).toMatch(
			/^Script completed\nWall time [\d.]+ seconds\nOutput:\nscript output$/,
		);
		expect(completion.details?.nestedCalls?.calls.map((call) => [call.name, call.status])).toEqual([["gated", "ok"]]);
		expect(completion.details?.resultDetails?.calls.map((call) => call.name)).toEqual(["gated"]);
		await vi.waitFor(() => expect(harness.session.getLastAssistantText()).toBe("after completion"));
		expect(harness.session.extensionRunner.getMessageRenderer(CODEMODE_BACKGROUND_COMPLETION_TYPE)).toBeDefined();

		const entries = usageEntries(harness);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			type: "usage",
			kind: CODEMODE_BACKGROUND_COMPLETION_TYPE,
			provider: "",
			model: "",
		});
		expect(getUsageCostBreakdown(harness.sessionManager.getBranch())).toContainEqual({
			key: "Tools/summaries",
			cost: 0.25,
			tokens: 100,
		});
		expect(harness.session.getSessionStats().cost).toBe(0.25);
		expect(storeEntries(harness)).toEqual([{ set: { step: 1 }, delete: [] }]);
	});

	it("delivers a script that finishes immediately after its receipt", async () => {
		const harness = await setup();
		await launch(harness, `${BACKGROUND}return "instant";`);

		const completion = await waitForCompletion(harness);
		expect(completionText(completion)).toMatch(/Output:\ninstant$/);
		const entries = harness.sessionManager.getEntries();
		const receiptIndex = entries.findIndex(
			(entry) => entry.type === "message" && entry.message.role === "toolResult",
		);
		const completionIndex = entries.findIndex(
			(entry) => entry.type === "custom_message" && entry.customType === CODEMODE_BACKGROUND_COMPLETION_TYPE,
		);
		expect(receiptIndex).toBeGreaterThanOrEqual(0);
		expect(completionIndex).toBeGreaterThan(receiptIndex);
	});

	it("keeps the run through a second prompt and delivers it afterwards", async () => {
		const gate = createGatedTool();
		const harness = await setup([gate.tool]);
		await launch(harness, `${BACKGROUND}await tools.gated({});\nstore("step", 1);\nreturn "finished";`, [
			"foreground done",
		]);
		await gate.started;

		harness.setResponses([fauxAssistantMessage("second answer"), fauxAssistantMessage("after completion")]);
		await harness.session.prompt("something else");

		expect(harness.session.getLastAssistantText()).toBe("second answer");
		expect(gate.aborted()).toBe(false);
		gate.release();
		const completion = await waitForCompletion(harness);
		expect(completionText(completion)).toMatch(/Output:\nfinished$/);
		expect(storeEntries(harness)).toEqual([{ set: { step: 1 }, delete: [] }]);
	});

	it("delivers a failure with its partial output", async () => {
		const harness = await setup();
		await launch(harness, `${BACKGROUND}text("partial");\nthrow new Error("boom");`, ["foreground done"]);

		const completion = await waitForCompletion(harness);
		expect(completion.details?.isError).toBe(true);
		expect(completion.content[0]).toEqual({
			type: "text",
			text: `Background run ${completion.details?.runId} failed.\n`,
		});
		const text = completionText(completion);
		expect(text).toMatch(/^Script failed\n/);
		expect(text).toContain("partial");
		expect(text).toContain("Script error:\nError: boom");
		expect(usageEntries(harness)).toHaveLength(0);
	});

	it("parks a background run's nested call, completion, usage, and commit through a save hold", async () => {
		const run = createHoldAttemptTool(usage(30, 0.3));
		const second = createGatedTool("second");
		const harness = await setup([second.tool], [toolExtension(run.tool)]);
		await promptTool(harness, "hold_attempt", ["foreground done", "after completion"]);
		await run.started;

		const hold = await harness.session.acquireWorkingSession();
		try {
			expect(hold.sleepReady).toBe(false);
			expect(hold.blockers).toContain(`Background run ${run.runId()} is active`);
			run.attempt();
			await run.attempted;
			// The attempted call waits for release before it reaches the nested pipeline.
			expect(second.starts()).toBe(0);
			expect(completions(harness, "test-background")).toHaveLength(0);
			expect(usageEntries(harness)).toHaveLength(0);
			expect(run.commits()).toBe(0);
		} finally {
			await hold.release();
		}

		await second.started;
		expect(second.starts()).toBe(1);
		second.release();
		const completion = await waitForCompletion(harness, "test-background");
		expect(completionText(completion)).toBe("second ran");
		expect(run.commits()).toBe(1);
		expect(usageEntries(harness)).toHaveLength(1);
	});

	it("reports a settled run that is waiting for delivery as a save blocker", async () => {
		const run = createDeferredRunTool(usage(40, 0.4));
		const saving = Promise.withResolvers<void>();
		const resumeSave = Promise.withResolvers<void>();
		const harness = await setup(
			[],
			[
				toolExtension(run.tool),
				(pi) => {
					pi.on("working_session_save", async () => {
						saving.resolve();
						await resumeSave.promise;
					});
				},
			],
		);
		await promptTool(harness, "deferred_run", ["foreground done", "after completion"]);
		await run.started;

		const pending = harness.session.acquireWorkingSession();
		await saving.promise;
		// The run settles while the save handler still holds collection, so its parked result, not
		// live compute, is the only record the snapshot would lose.
		run.finish();
		await flush();
		resumeSave.resolve();
		const hold = await pending;
		try {
			expect(hold.sleepReady).toBe(false);
			expect(hold.blockers).toContain(`Background run ${run.runId()} is awaiting delivery`);
			expect(usageEntries(harness)).toHaveLength(0);
			expect(completions(harness, "test-background")).toHaveLength(0);
		} finally {
			await hold.release();
		}

		const completion = await waitForCompletion(harness, "test-background");
		expect(completionText(completion)).toBe("work output");
		expect(usageEntries(harness)).toHaveLength(1);
		await flush();
		expect(completions(harness, "test-background")).toHaveLength(1);
		expect(usageEntries(harness)).toHaveLength(1);
	});

	it("keeps a settled run's known usage when the session is disposed during a save hold", async () => {
		const run = createDeferredRunTool(usage(40, 0.4));
		const harness = await setup([], [toolExtension(run.tool)]);
		await promptTool(harness, "deferred_run", ["foreground done"]);
		await run.started;

		const hold = await harness.session.acquireWorkingSession();
		run.finish();
		await flush();
		expect(usageEntries(harness)).toHaveLength(0);

		harness.session.dispose();

		await vi.waitFor(() => expect(usageEntries(harness)).toHaveLength(1));
		expect(getUsageCostBreakdown(harness.sessionManager.getBranch())).toContainEqual({
			key: "Tools/summaries",
			cost: 0.4,
			tokens: 40,
		});
		expect(completions(harness, "test-background")).toHaveLength(0);
		await hold.release();
		expect(completions(harness, "test-background")).toHaveLength(0);
	});

	it("aborts the work of a run when the session aborts", async () => {
		const gate = createGatedTool();
		const harness = await setup([gate.tool]);
		await launch(harness, `${BACKGROUND}await tools.gated({});\nstore("step", 1);\nreturn "never";`);
		await gate.started;
		expect(gate.starts()).toBe(1);

		await harness.session.abort();

		expect(gate.aborted()).toBe(true);
		expect(completions(harness)).toHaveLength(0);
		expect(storeEntries(harness)).toHaveLength(0);
		expect(usageEntries(harness)).toHaveLength(0);
	});

	it("aborts the work of a run when the session is disposed", async () => {
		const gate = createGatedTool();
		const harness = await setup([gate.tool]);
		await launch(harness, `${BACKGROUND}await tools.gated({});\nstore("step", 1);\nreturn "never";`);
		await gate.started;
		expect(gate.starts()).toBe(1);

		harness.session.dispose();

		await vi.waitFor(() => expect(gate.aborted()).toBe(true));
		expect(storeEntries(harness)).toHaveLength(0);
	});

	it("stops a run when the session tree navigates away from its branch", async () => {
		const gate = createGatedTool();
		const harness = await setup([gate.tool]);
		await launch(harness, `${BACKGROUND}await tools.gated({});\nstore("step", 1);\nreturn "never";`, [
			"foreground done",
		]);
		await gate.started;

		const firstPrompt = harness.sessionManager.getBranch().find((entry) => entry.type === "message");
		if (!firstPrompt) throw new Error("No first prompt entry");
		await harness.session.navigateTree(firstPrompt.id);

		expect(gate.aborted()).toBe(true);
		expect(completions(harness)).toHaveLength(0);
		expect(storeEntries(harness)).toHaveLength(0);
		expect(usageEntries(harness)).toHaveLength(0);
	});

	it("keeps a run alive when tree navigation is rejected", async () => {
		const gate = createGatedTool();
		const harness = await setup([gate.tool]);
		await launch(harness, `${BACKGROUND}await tools.gated({});\nreturn "kept";`, ["foreground done"]);

		await gate.started;
		await expect(harness.session.navigateTree("entry-that-does-not-exist")).rejects.toThrow(/not found/);
		expect(gate.aborted()).toBe(false);
		expect(completions(harness)).toHaveLength(0);

		gate.release();
		const completion = await waitForCompletion(harness);
		expect(completionText(completion)).toMatch(/Output:\nkept$/);
	});

	it("stops a run and records nothing it did not finish when extensions reload", async () => {
		const gate = createGatedTool();
		const harness = await setup([gate.tool]);
		await launch(harness, `${BACKGROUND}await tools.gated({});\nstore("step", 1);\nreturn "never";`, [
			"foreground done",
		]);
		await gate.started;

		await harness.session.reload();

		expect(gate.aborted()).toBe(true);
		expect(completions(harness)).toHaveLength(0);
		expect(storeEntries(harness)).toHaveLength(0);
		expect(usageEntries(harness)).toHaveLength(0);
	});

	it("rejects a run from a tool call that already returned, and later runs still deliver", async () => {
		const gate = createGatedTool("gated");
		let retained: { runInBackground: (type: string, work: () => Promise<never>) => string } | undefined;
		const harness = await setup(
			[gate.tool],
			[
				(pi) =>
					pi.registerTool({
						name: "retain",
						label: "retain",
						description: "Keeps its context after the call returns",
						parameters: Type.Object({}),
						execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
							retained = ctx;
							return { content: [{ type: "text", text: "kept" }], details: undefined };
						},
					}),
			],
		);
		await promptTool(harness, "retain");

		expect(() =>
			retained!.runInBackground("test-background", async () => {
				throw new Error("never runs");
			}),
		).toThrow("runInBackground() is only available to the model-issued tool call that is running");

		await launch(harness, `${BACKGROUND}await tools.gated({});\nreturn "later";`);
		await gate.started;
		gate.release();
		const completion = await waitForCompletion(harness);
		expect(completionText(completion)).toMatch(/Output:\nlater$/);
	});

	it("gives a late background call the run's signal, so cancelling the run releases its hook", async () => {
		const waiting = createGatedTool("waiting");
		const guarded = createGatedTool("guarded");
		let hookSignal: AbortSignal | undefined;
		let hookAborted = false;
		const harness = await setup(
			[waiting.tool, guarded.tool],
			[
				(pi) => {
					pi.on("tool_call", async (event, ctx) => {
						if (event.toolName !== "guarded") return;
						hookSignal = ctx.signal;
						await new Promise<void>((resolve) => {
							if (ctx.signal?.aborted) {
								hookAborted = true;
								resolve();
								return;
							}
							ctx.signal?.addEventListener(
								"abort",
								() => {
									hookAborted = true;
									resolve();
								},
								{ once: true },
							);
						});
					});
				},
			],
		);
		await launch(harness, `${BACKGROUND}await tools.waiting({});\nawait tools.guarded({});\nreturn "never";`, [
			"foreground done",
		]);
		await waiting.started;
		expect(harness.session.getLastAssistantText()).toBe("foreground done");

		waiting.release();
		await vi.waitFor(() => expect(hookSignal).toBeDefined());
		expect(guarded.starts()).toBe(0);

		// Navigation cancels only this run; the session's own signal stays live, so the hook can only
		// be released by the signal of the run that made the call.
		const firstPrompt = harness.sessionManager.getBranch().find((entry) => entry.type === "message");
		if (!firstPrompt) throw new Error("No first prompt entry");
		await harness.session.navigateTree(firstPrompt.id);

		expect(hookAborted).toBe(true);
		expect(hookSignal?.aborted).toBe(true);
		expect(guarded.starts()).toBe(0);
		const hold = await harness.session.acquireWorkingSession();
		await hold.release();
	});

	it("rejects a second run for the same tool call", async () => {
		const harness = await setup(
			[],
			[
				(pi) =>
					pi.registerTool({
						name: "double",
						label: "double",
						description: "Starts two background runs",
						parameters: Type.Object({}),
						execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
							const work = async () => ({
								content: [{ type: "text" as const, text: "ran" }],
								details: undefined,
							});
							ctx.runInBackground("test-background", work);
							let duplicate = "";
							try {
								ctx.runInBackground("test-background", work);
							} catch (error) {
								duplicate = error instanceof Error ? error.message : String(error);
							}
							return { content: [{ type: "text", text: duplicate }], details: undefined };
						},
					}),
			],
		);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("double", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		const result = harness.session.messages.findLast(
			(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "double",
		);
		expect((result?.content[0] as TextContent | undefined)?.text).toMatch(/^Background run .+ is already active$/);
		await vi.waitFor(() =>
			expect(
				harness.session.messages.filter(
					(message) => message.role === "custom" && message.customType === "test-background",
				),
			).toHaveLength(1),
		);
	});

	it("rejects a run started by a nested call", async () => {
		const harness = await setup(
			[],
			[
				(pi) =>
					pi.registerTool({
						name: "nested_launch",
						label: "nested_launch",
						description: "Tries to start a background run from a nested call",
						parameters: Type.Object({}),
						execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
							try {
								ctx.runInBackground("test-background", async () => ({
									content: [{ type: "text" as const, text: "ran" }],
									details: undefined,
								}));
							} catch (error) {
								return {
									content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
									details: undefined,
								};
							}
							return { content: [{ type: "text", text: "started" }], details: undefined };
						},
					}),
			],
		);
		await launch(harness, `return await tools.nested_launch({});`, ["foreground done"]);

		expect(messageText(codemodeResult(harness))).toContain(
			"runInBackground() is only available to the model-issued tool call that is running",
		);
	});

	it("records model and descendant nested usage of a background script once", async () => {
		const judge: ClassifierModel<"test-classifier"> = {
			type: "classifier",
			id: "judge",
			name: "Judge",
			api: "test-classifier",
			provider: "scorer",
			baseUrl: "https://classifier.test/v1",
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
		};
		const inner: AgentTool = {
			name: "inner",
			label: "inner",
			description: "Reports usage",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "inner ran" }], details: {}, usage: usage(20, 0.2) }),
		};
		const outer: ToolDefinition = {
			name: "outer",
			label: "outer",
			description: "Calls another tool",
			parameters: Type.Object({}),
			execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
				const outcome = await ctx.executeTool("inner", {});
				return { content: [{ type: "text", text: resultText(outcome.result) }], details: undefined };
			},
		};
		const harness = await setup([inner], [toolExtension(outer)]);
		harness.session.modelRuntime.registerProvider("scorer", {
			apiKey: "secret-key",
			models: [judge],
			classifiers: {
				"test-classifier": {
					classify: async (model) => ({
						api: model.api,
						provider: model.provider,
						model: model.id,
						answers: { approved: { type: "bool", probability: 1 } },
						usage: usage(7, 0.07),
						stopReason: "stop",
						timestamp: 0,
					}),
				},
			},
		});

		await launch(
			harness,
			`${BACKGROUND}const answer = await models.classify({ provider: "scorer", id: "judge" }, { state: { text: "x" }, questions: { approved: { type: "bool", instructions: "Approve?", criteria: { true: "yes", false: "no" } } } });\nawait tools.outer({});\nreturn answer.answers.approved.probability;`,
		);

		const completion = await waitForCompletion(harness);
		expect(completionText(completion)).toMatch(/Output:\n1$/);
		expect(completion.details?.nestedCalls?.calls.map((call) => call.name)).toEqual(["outer", "inner"]);
		expect(completion.details?.resultDetails?.calls.map((call) => call.name)).toEqual(["models.classify", "outer"]);
		const entries = usageEntries(harness);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ usage: { totalTokens: 27 } });
		expect(getUsageCostBreakdown(harness.sessionManager.getBranch())).toContainEqual({
			key: "Tools/summaries",
			cost: 0.27,
			tokens: 27,
		});
	});

	it("normalizes the completion's images like a tool result", async () => {
		const imageRun: ToolDefinition = {
			name: "image_run",
			label: "image_run",
			description: "Delivers an image",
			parameters: Type.Object({}),
			execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
				ctx.runInBackground("test-background", async () => ({
					content: [{ type: "image" as const, data: createTinyBmp(), mimeType: "image/bmp" }],
					details: undefined,
				}));
				return { content: [{ type: "text", text: "started" }], details: undefined };
			},
		};
		const harness = await setup([], [toolExtension(imageRun)]);
		await promptTool(harness, "image_run", ["foreground done", "after completion"]);

		await vi.waitFor(() => expect(completions(harness, "test-background")).toHaveLength(1));
		const completion = completions(harness, "test-background")[0]!;
		if (typeof completion.content === "string") throw new Error("No image completion");
		const image = completion.content.find((block) => block.type === "image");
		expect(image).toMatchObject({ type: "image", mimeType: "image/png" });
		expect(completion.content.map((block) => block.type)).toEqual(["text", "image", "text"]);
		expect(resultText({ content: completion.content })).toContain("[Image converted from image/bmp to image/png.]");
	});

	it("runs sequential nested calls of a background script one at a time", async () => {
		let running = 0;
		let maxRunning = 0;
		const slowSchema = Type.Object({ note: Type.String() });
		const slow: AgentTool<typeof slowSchema> = {
			name: "slow",
			label: "slow",
			description: "Runs one at a time",
			executionMode: "sequential",
			parameters: slowSchema,
			execute: async (_id, params) => {
				running++;
				maxRunning = Math.max(maxRunning, running);
				await new Promise((resolve) => setTimeout(resolve, 20));
				running--;
				return { content: [{ type: "text", text: params.note }], details: {} };
			},
		};
		const harness = await setup([slow]);
		await launch(
			harness,
			`${BACKGROUND}const notes = await Promise.all([tools.slow({ note: "a" }), tools.slow({ note: "b" })]);\nreturn notes.join(",");`,
		);

		const completion = await waitForCompletion(harness);
		expect(maxRunning).toBe(1);
		expect(completionText(completion)).toMatch(/Output:\na,b$/);
	});
});
