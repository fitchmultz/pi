import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

function seedHistory(harness: Harness): void {
	const model = harness.session.model!;
	for (const label of ["old", "recent"]) {
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: label.padEnd(400, "x") }],
			timestamp: Date.now() - 2000,
		});
		const assistant = fauxAssistantMessage(label.padEnd(400, "y"), { timestamp: Date.now() - 1000 });
		harness.sessionManager.appendMessage({
			...assistant,
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: { ...assistant.usage, input: 4950, totalTokens: 4950 },
		});
	}
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

describe("context ceilings in a session", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("applies a refreshed ceiling to the already-selected model before compaction and dispatch", async () => {
		const harness = await createHarness({
			models: [{ id: "large", contextWindow: 10000 }],
			modelsJson: { providers: {} },
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 100 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", ({ preparation }) => ({
						compaction: {
							summary: "compacted",
							firstKeptEntryId: preparation.firstKeptEntryId,
							tokensBefore: preparation.tokensBefore,
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		seedHistory(harness);
		writeFileSync(
			join(harness.tempDir, "models.json"),
			JSON.stringify({ providers: {}, contextWindowCaps: { default: 5000 } }),
		);
		await harness.session.modelRuntime.refresh({ allowNetwork: false });
		let requestWindow = 0;
		let compactedBeforeRequest = false;
		let stateWindow = 0;
		harness.setResponses([
			(_context, _options, _state, model) => {
				requestWindow = model.contextWindow;
				stateWindow = harness.session.state.model.contextWindow;
				compactedBeforeRequest = harness.eventsOfType("compaction_end").some((event) => event.result !== undefined);
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("continue");

		expect(compactedBeforeRequest).toBe(true);
		expect(requestWindow).toBe(5000);
		expect(stateWindow).toBe(5000);
		expect(harness.session.getContextUsage()?.contextWindow).toBe(5000);

		for (const [caps, window] of [
			[{ default: 8000 }, 8000],
			[undefined, 10000],
		] as const) {
			writeFileSync(
				join(harness.tempDir, "models.json"),
				JSON.stringify({ providers: {}, contextWindowCaps: caps }),
			);
			await harness.session.modelRuntime.refresh({ allowNetwork: false });
			expect(harness.session.model?.contextWindow).toBe(window);
			harness.setResponses([
				(_context, _options, _state, model) => {
					requestWindow = model.contextWindow;
					stateWindow = harness.session.state.model.contextWindow;
					return fauxAssistantMessage("done");
				},
			]);
			await harness.session.prompt("continue again");
			expect(requestWindow).toBe(window);
			expect(stateWindow).toBe(window);
		}
	});

	it("does not raise a smaller model supplied by an SDK caller", async () => {
		const harness = await createHarness({
			models: [{ id: "large", contextWindow: 10000 }],
			modelsJson: { contextWindowCaps: { default: 5000 } },
			settings: { compaction: { enabled: false } },
		});
		harnesses.push(harness);
		await harness.session.setModel({ ...harness.getModel(), contextWindow: 3000 });
		let dispatchedWindow = 0;
		harness.setResponses([
			(_context, _options, _state, model) => {
				dispatchedWindow = model.contextWindow;
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("continue");

		expect(dispatchedWindow).toBe(3000);
		expect(harness.session.model?.contextWindow).toBe(3000);
	});

	it("compacts against the routed physical ceiling before dispatch", async () => {
		const harness = await createHarness({
			models: [{ id: "large", contextWindow: 10000 }],
			modelsJson: { contextWindowCaps: { default: 10000, providers: { faux: 5000 } } },
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 100 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", ({ preparation }) => ({
						compaction: {
							summary: "compacted",
							firstKeptEntryId: preparation.firstKeptEntryId,
							tokensBefore: preparation.tokensBefore,
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		const runtime = harness.session.modelRuntime;
		const previous = fauxProvider({ provider: "previous", models: [{ id: "big", contextWindow: 10000 }] });
		runtime.registerNativeProvider(previous.provider);
		harness.session.agent.state.model = previous.getModel();
		seedHistory(harness);
		runtime.registerVirtualModel({
			provider: "router",
			id: "auto",
			name: "Auto",
			contextWindow: 10000,
			route: () => ({ model: harness.getModel(), thinkingLevel: "off" }),
		});
		await runtime.refresh({ allowNetwork: false });
		await harness.session.setModel(runtime.getModel("router", "auto")!);
		let requestWindow = 0;
		let compactedBeforeRequest = false;
		harness.setResponses([
			(_context, _options, _state, model) => {
				requestWindow = model.contextWindow;
				compactedBeforeRequest = harness.eventsOfType("compaction_end").some((event) => event.result !== undefined);
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("continue");

		expect(compactedBeforeRequest).toBe(true);
		expect(requestWindow).toBe(5000);
		expect(harness.session.model?.id).toBe("auto");
		expect(harness.session.getContextUsage()?.contextWindow).toBe(5000);
	});
});
