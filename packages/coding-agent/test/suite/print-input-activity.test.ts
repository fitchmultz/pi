import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { runPrintMode } from "../../src/modes/print-mode.ts";
import { createHarness, getAssistantTexts, getMessageText, getUserTexts, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		await harness.session.abort();
		harness.cleanup();
	}
	vi.restoreAllMocks();
});

function createRuntime(harness: Harness): AgentSessionRuntime {
	return new AgentSessionRuntime(
		harness.session,
		{
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			modelRuntime: harness.session.modelRuntime,
			settingsManager: harness.settingsManager,
			resourceLoader: harness.session.resourceLoader,
			diagnostics: [],
		},
		async () => {
			throw new Error("These prompts must not replace the session");
		},
	);
}

describe("print-mode input activity", () => {
	it.each(["text", "json"] as const)(
		"exposes queued prompts and finishes a settlement-started response before %s output and shutdown",
		async (mode) => {
			const startCounts: number[] = [];
			const inputCounts: number[] = [];
			const settledCounts: number[] = [];
			const shutdownMessages: string[] = [];
			let sent = false;
			const harness = await createHarness({
				tools: [],
				settings: { compaction: { enabled: false }, retry: { enabled: false } },
				extensionFactories: [
					(pi) => {
						pi.on("session_start", (_event, ctx) => {
							startCounts.push(ctx.getPendingInputCount());
						});
						pi.on("input", (_event, ctx) => {
							inputCounts.push(ctx.getPendingInputCount());
						});
						pi.on("agent_settled", (_event, ctx) => {
							const pending = ctx.getPendingInputCount();
							settledCounts.push(pending);
							if (pending === 0 && !sent) {
								sent = true;
								pi.sendMessage(
									{ customType: "notification", content: "extension input", display: true },
									{ triggerTurn: true },
								);
							}
						});
						pi.on("session_shutdown", (_event, ctx) => {
							const last = ctx.sessionManager.getBranch().at(-1);
							shutdownMessages.push(getMessageText(last?.type === "message" ? last.message : undefined));
						});
					},
				],
			});
			harnesses.push(harness);
			harness.setResponses(
				["first answer", "second answer", "third answer", "extension answer"].map((text) =>
					fauxAssistantMessage(text),
				),
			);
			const stdout = vi.spyOn(process.stdout, "write");
			const errors = vi.spyOn(console, "error").mockImplementation(() => {});

			const exitCode = await runPrintMode(createRuntime(harness), {
				mode,
				initialMessage: "first",
				messages: ["second", "third"],
			});

			expect(errors).not.toHaveBeenCalled();
			expect(exitCode).toBe(0);
			expect(startCounts).toEqual([3]);
			expect(inputCounts).toEqual([3, 2, 1]);
			expect(settledCounts).toEqual([2, 1, 0, 0]);
			expect(getUserTexts(harness)).toEqual(["first", "second", "third"]);
			expect(getAssistantTexts(harness)).toEqual([
				"first answer",
				"second answer",
				"third answer",
				"extension answer",
			]);
			expect(shutdownMessages).toEqual(["extension answer"]);
			const output = stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
			if (mode === "text") {
				expect(output).toBe("extension answer\n");
			} else {
				const messages = output
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line))
					.filter((event) => event.type === "message_end")
					.map((event) => getMessageText(event.message));
				expect(messages).toEqual([
					"first",
					"first answer",
					"second",
					"second answer",
					"third",
					"third answer",
					"extension input",
					"extension answer",
				]);
			}
		},
	);

	it("waits for extension turns before the initial and next CLI prompts", async () => {
		let lastInput: string | undefined;
		let sent = false;
		const harness = await createHarness({
			tools: [],
			settings: { compaction: { enabled: false }, retry: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("session_start", () => {
						pi.sendMessage(
							{ customType: "notification", content: "startup", display: true },
							{ triggerTurn: true },
						);
					});
					pi.on("input", (event) => {
						lastInput = event.text;
					});
					pi.on("agent_settled", () => {
						if (lastInput === "first" && !sent) {
							sent = true;
							pi.sendMessage(
								{ customType: "notification", content: "between", display: true },
								{ triggerTurn: true },
							);
						}
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses(
			["startup answer", "first answer", "between answer", "second answer"].map((text) =>
				fauxAssistantMessage(text),
			),
		);
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(createRuntime(harness), {
			mode: "text",
			initialMessage: "first",
			messages: ["second"],
		});

		expect(errors).not.toHaveBeenCalled();
		expect(exitCode).toBe(0);
		expect(harness.session.messages.map(getMessageText)).toEqual([
			"startup",
			"startup answer",
			"first",
			"first answer",
			"between",
			"between answer",
			"second",
			"second answer",
		]);
	});
});
