import {
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemPrompt,
	getCurrentTools,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import { createHarness, getToolResult, type Harness } from "./harness.ts";

describe("historical hidden loadouts", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it.each([{ initialActiveToolNames: [] }, { initialActiveToolNames: ["read"] }])(
		"keeps startup policy and branch prefixes with initial tools $initialActiveToolNames",
		async ({ initialActiveToolNames }) => {
			let starts = 0;
			const harness = await createHarness({
				initialActiveToolNames,
				extensionFactories: [
					(pi) => {
						pi.registerTool({
							name: "later",
							label: "Later",
							description: "Later tool",
							exposure: "deferred",
							parameters: Type.Object({}),
							execute: async () => ({ content: [], details: {} }),
						});
						pi.on("session_start", () =>
							pi.sendMessage({ customType: "startup", content: "STARTUP POLICY", display: false }),
						);
						pi.on("before_agent_start", () => {
							starts++;
						});
						pi.on("context_with_system", (event) => ({
							messages: event.messages.map((message) =>
								message.role === "custom" && message.customType === "startup"
									? { role: "system", content: "STARTUP POLICY", timestamp: message.timestamp }
									: message,
							),
						}));
					},
				],
			});
			harnesses.push(harness);
			await harness.session.bindExtensions({});
			const requests: TranscriptContext["messages"][] = [];
			const response = (context: TranscriptContext) => {
				requests.push(structuredClone(context.messages));
				return fauxAssistantMessage("done");
			};
			harness.setResponses([response, response, response, response]);
			await harness.session.prompt("first");
			const forkPoint = harness.sessionManager.getLeafId()!;
			harness.session.setActiveToolsByName([...initialActiveToolNames, "later"]);
			await harness.session.sendCustomMessage(
				{ customType: "incoming", content: "incoming coordination", display: false },
				{ triggerTurn: true },
			);
			expect(starts).toBe(2);
			expect(requests[1].slice(0, requests[0].length)).toEqual(requests[0]);
			expect(getCurrentTools(requests[1]).map((tool) => tool.name)).toEqual([...initialActiveToolNames, "later"]);
			await harness.session.prompt("abandoned");
			harness.sessionManager.createBranchedSession(forkPoint);
			const resumed = await createHarness({
				sessionManager: harness.sessionManager,
				resourceLoader: harness.session.resourceLoader,
			});
			harnesses.push(resumed);
			expect(resumed.session.getActiveToolNames()).toEqual(initialActiveToolNames);
			resumed.setResponses([response]);
			await resumed.session.prompt("forked");
			expect(requests[3].slice(0, requests[0].length)).toEqual(requests[0]);
			expect(getCurrentSystemPrompt(requests[3])).toContain("STARTUP POLICY");
			expect(JSON.stringify(requests[3])).not.toContain("abandoned");
			expect(getCurrentTools(requests[3]).map((tool) => tool.name)).toEqual(initialActiveToolNames);
		},
	);

	it("hides initial declarations without changing callable permissions and rejects deactivated tools", async () => {
		let executions = 0;
		const harness = await createHarness({
			initialActiveToolNames: ["hidden", "wrapper"],
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "hidden",
						label: "Hidden",
						description: "Hidden",
						parameters: Type.Object({}),
						execute: async () => {
							executions++;
							return { content: [], details: {} };
						},
					});
					pi.registerTool({
						name: "wrapper",
						label: "Wrapper",
						description: "Wrapper",
						parameters: Type.Object({}),
						prepareLoadout: () => ({ hiddenDeclarations: ["hidden"] }),
						execute: async () => ({ content: [], details: {} }),
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			(context) => {
				expect(getCurrentTools(context.messages).map((tool) => tool.name)).toEqual(["wrapper"]);
				return fauxAssistantMessage(fauxToolCall("hidden", {}), { stopReason: "toolUse" });
			},
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("try hidden direct call");
		expect(executions).toBe(1);
		expect(getToolResult(harness, "hidden").isError).toBe(false);
		harness.session.setActiveToolsByName(["wrapper"]);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("hidden", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("try deactivated call");
		expect(executions).toBe(1);
		expect(getToolResult(harness, "hidden").isError).toBe(true);
	});

	it("preserves declared prefixes while hiding, restoring, and resuming callable selections", async () => {
		let hidden = false;
		const extension: ExtensionFactory = (pi) => {
			for (const name of ["shell", "wrapper"])
				pi.registerTool({
					name,
					label: name,
					description: name,
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					...(name === "wrapper"
						? { prepareLoadout: () => ({ hiddenDeclarations: hidden ? ["shell"] : [] }) }
						: {}),
				});
		};
		const harness = await createHarness({
			extensionFactories: [extension],
			initialActiveToolNames: ["shell", "wrapper"],
		});
		harnesses.push(harness);
		const requests: TranscriptContext["messages"][] = [];
		const response = (context: TranscriptContext) => {
			requests.push(structuredClone(context.messages));
			return fauxAssistantMessage("done");
		};
		harness.setResponses([response, response, response]);
		await harness.session.prompt("visible");
		const originalSystem = requests[0].find((message) => message.role === "system");
		expect(getCurrentTools(requests[0]).map((tool) => tool.name)).toEqual(["shell", "wrapper"]);
		hidden = true;
		harness.session.setActiveToolsByName(["shell", "wrapper"]);
		await harness.session.prompt("hidden");
		expect(requests[1].find((message) => message.role === "system")).toEqual(originalSystem);
		expect(getCurrentTools(requests[1]).map((tool) => tool.name)).toEqual(["wrapper"]);
		expect(harness.session.getActiveToolNames()).toEqual(["shell", "wrapper"]);
		const resumed = await createHarness({ sessionManager: harness.sessionManager, extensionFactories: [extension] });
		harnesses.push(resumed);
		expect(resumed.session.getActiveToolNames()).toEqual(["shell", "wrapper"]);
		hidden = false;
		harness.session.setActiveToolsByName(["shell", "wrapper"]);
		await harness.session.prompt("visible again");
		expect(requests[2].find((message) => message.role === "system")).toEqual(originalSystem);
		expect(
			getCurrentTools(requests[2])
				.map((tool) => tool.name)
				.sort(),
		).toEqual(["shell", "wrapper"]);
	});
});
