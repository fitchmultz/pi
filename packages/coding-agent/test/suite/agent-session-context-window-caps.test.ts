import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, type Model } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
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

	it.each([
		{ catalog: 10000, window: 3000, expected: 3000 },
		{ catalog: 10000, window: 0, expected: 0 },
		{ catalog: 0, window: 3000, expected: 3000 },
		{ catalog: 0, window: 9000, expected: 5000 },
	])(
		"preserves an SDK-supplied window of $window when the catalog reports $catalog",
		async ({ catalog, window, expected }) => {
			const harness = await createHarness({
				models: [{ id: "large", contextWindow: catalog }],
				modelsJson: { contextWindowCaps: { default: 5000 } },
				settings: { compaction: { enabled: false } },
			});
			harnesses.push(harness);
			const baseUrl = "http://127.0.0.1:0/unknown-proxy";
			await harness.session.setModel({ ...harness.getModel(), contextWindow: window, baseUrl });
			let dispatchedWindow = 0;
			let dispatchedUrl = "";
			harness.setResponses([
				(_context, _options, _state, model) => {
					dispatchedWindow = model.contextWindow;
					dispatchedUrl = model.baseUrl;
					return fauxAssistantMessage("done");
				},
			]);

			await harness.session.prompt("continue");

			expect(dispatchedWindow).toBe(expected);
			expect(dispatchedUrl).toBe(baseUrl);
			expect(harness.session.model?.contextWindow).toBe(expected);
		},
	);

	it("compacts before dispatch when a start handler selects a smaller physical ceiling", async () => {
		let target: Model<string>;
		const harness = await createHarness({
			models: [{ id: "large", contextWindow: 10000 }],
			modelsJson: { contextWindowCaps: { default: 10000, providers: { local: 5000 } } },
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 100 } },
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => {
						await pi.setModel(target);
					});
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
		const local = registerFauxProvider({ provider: "local", models: [{ id: "small", contextWindow: 10000 }] });
		const localModel = local.getModel();
		const runtime = harness.session.modelRuntime;
		runtime.registerProvider("local", {
			api: local.api,
			baseUrl: localModel.baseUrl,
			apiKey: "fixture",
			models: local.models,
		});
		await runtime.refresh({ allowNetwork: false });
		target = runtime.getModel("local", "small")!;
		seedHistory(harness);
		let requestWindow = 0;
		let compactedBeforeRequest = false;
		local.setResponses([
			(_context, _options, _state, model) => {
				requestWindow = model.contextWindow;
				compactedBeforeRequest = harness.eventsOfType("compaction_end").some((event) => event.result !== undefined);
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("continue");

		expect(requestWindow).toBe(5000);
		expect(compactedBeforeRequest).toBe(true);
	});

	it.each(["physical", "virtual"] as const)("uses the %s model selected by the compaction handler", async (kind) => {
		let target: Model<string>;
		const harness = await createHarness({
			models: [{ id: "large", contextWindow: 10000 }],
			modelsJson: { contextWindowCaps: { default: 5000 } },
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 100 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async ({ preparation }) => {
						await pi.setModel(target);
						return {
							compaction: {
								summary: "compacted",
								firstKeptEntryId: preparation.firstKeptEntryId,
								tokensBefore: preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		const local = registerFauxProvider({ provider: "local", models: [{ id: "other", contextWindow: 10000 }] });
		const localModel = local.getModel();
		const runtime = harness.session.modelRuntime;
		runtime.registerProvider("local", {
			api: local.api,
			baseUrl: localModel.baseUrl,
			apiKey: "fixture",
			models: local.models,
		});
		runtime.registerVirtualModel({
			provider: "router",
			id: "auto",
			name: "Auto",
			contextWindow: 10000,
			route: () => ({ model: localModel, thinkingLevel: "off" }),
		});
		await runtime.refresh({ allowNetwork: false });
		target = kind === "physical" ? runtime.getModel("local", "other")! : runtime.getModel("router", "auto")!;
		seedHistory(harness);
		let dispatched = "";
		local.setResponses([
			(_context, _options, _state, model) => {
				dispatched = `${model.provider}/${model.id}`;
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("continue");

		expect(harness.session.model?.provider).toBe(kind === "physical" ? "local" : "router");
		expect(dispatched).toBe("local/other");
	});

	it.each(["threshold", "overflow"] as const)("does not repeat a cancelled %s compaction", async (reason) => {
		let attempts = 0;
		const harness = await createHarness({
			models: [{ id: "large", contextWindow: 10000 }],
			modelsJson: { contextWindowCaps: { default: 5000 } },
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 100 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", () => {
						attempts++;
						return { cancel: true };
					});
				},
			],
		});
		harnesses.push(harness);
		seedHistory(harness);
		if (reason === "overflow") {
			const model = harness.session.model!;
			harness.sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "retry" }],
				timestamp: Date.now() - 1000,
			});
			const error = fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "maximum context length exceeded",
			});
			harness.sessionManager.appendMessage({ ...error, api: model.api, provider: model.provider, model: model.id });
			harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		}
		harness.setResponses([fauxAssistantMessage("done")]);

		await harness.session.prompt("continue");

		expect(attempts).toBe(1);
	});

	it("waits for the next virtual route before applying a refreshed physical ceiling", async () => {
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
		const local = registerFauxProvider({ provider: "local", models: [{ id: "small", contextWindow: 10000 }] });
		const localModel = local.getModel();
		const runtime = harness.session.modelRuntime;
		runtime.registerProvider("local", {
			api: local.api,
			baseUrl: localModel.baseUrl,
			apiKey: "fixture",
			models: local.models,
		});
		let routes = 0;
		let compactedBeforeThirdRoute = false;
		runtime.registerVirtualModel({
			provider: "router",
			id: "auto",
			name: "Auto",
			contextWindow: 10000,
			route: () => {
				routes++;
				if (routes === 3) {
					compactedBeforeThirdRoute = harness
						.eventsOfType("compaction_end")
						.some((event) => event.result !== undefined);
				}
				return { model: routes <= 2 ? localModel : harness.getModel(), thinkingLevel: "off" };
			},
		});
		await runtime.refresh({ allowNetwork: false });
		await harness.session.setModel(runtime.getModel("router", "auto")!);
		harness.session.agent.streamFunction = (model, context, options) => runtime.streamSimple(model, context, options);
		local.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		await harness.session.prompt("first");
		await harness.session.prompt("x".repeat(20000));
		expect(harness.session.getContextUsage()?.tokens).toBeGreaterThan(5000);
		expect(harness.eventsOfType("compaction_end")).toHaveLength(0);
		writeFileSync(
			join(harness.tempDir, "models.json"),
			JSON.stringify({ contextWindowCaps: { default: 10000, providers: { local: 5000 } } }),
		);
		await runtime.refresh({ allowNetwork: false });
		let requestWindow = 0;
		harness.setResponses([
			(_context, _options, _state, model) => {
				requestWindow = model.contextWindow;
				return fauxAssistantMessage("large answer");
			},
		]);

		await harness.session.prompt("switch to the large route");

		expect(routes).toBe(3);
		expect(compactedBeforeThirdRoute).toBe(false);
		expect(harness.eventsOfType("compaction_end")).toHaveLength(0);
		expect(requestWindow).toBe(10000);
	});

	it.each([
		{ initialWindow: 0, movesEndpoint: false, expected: 5000 },
		{ initialWindow: 3000, movesEndpoint: false, expected: 5000 },
		{ initialWindow: 0, movesEndpoint: true, expected: 0 },
		{ initialWindow: 3000, movesEndpoint: true, expected: 3000 },
	])(
		"refreshes a retained window of $initialWindow when movesEndpoint=$movesEndpoint",
		async ({ initialWindow, movesEndpoint, expected }) => {
			const harness = await createHarness({
				models: [{ id: "dynamic", contextWindow: initialWindow }],
				modelsJson: { contextWindowCaps: { default: 5000 } },
				settings: { compaction: { enabled: false } },
			});
			harnesses.push(harness);
			const runtime = harness.session.modelRuntime;
			const mock = fauxProvider({ provider: "faux", models: [{ id: "dynamic", contextWindow: 10000 }] });
			let reportedWindow = initialWindow;
			let nextWindow = initialWindow;
			let reportedUrl = mock.getModel().baseUrl;
			let nextUrl = reportedUrl;
			runtime.registerNativeProvider({
				...mock.provider,
				getModels: () => [{ ...mock.getModel(), contextWindow: reportedWindow, baseUrl: reportedUrl }],
				refreshModels: async ({ publish }) => {
					await publish({
						update: () => {
							reportedWindow = nextWindow;
							reportedUrl = nextUrl;
						},
					});
				},
			});
			await runtime.refresh({ allowNetwork: false });
			await harness.session.setModel(runtime.getModel("faux", "dynamic")!);
			expect(harness.session.model?.contextWindow).toBe(initialWindow);
			nextWindow = 10000;
			if (movesEndpoint) nextUrl = "http://127.0.0.1:0/new-endpoint";
			await runtime.refresh({ allowNetwork: false, providers: ["faux"] });
			expect(runtime.getModel("faux", "dynamic")?.contextWindow).toBe(5000);
			expect(harness.session.model?.contextWindow).toBe(expected);
			let dispatchedWindow = 0;
			mock.setResponses([
				(_context, _options, _state, model) => {
					dispatchedWindow = model.contextWindow;
					return fauxAssistantMessage("done");
				},
			]);
			harness.session.agent.streamFunction = (model, context, options) =>
				runtime.streamSimple(model, context, options);

			await harness.session.prompt("continue");

			expect(dispatchedWindow).toBe(expected);
			if (expected === 0) expect(harness.session.getContextUsage()).toBeUndefined();
			else expect(harness.session.getContextUsage()?.contextWindow).toBe(expected);
			nextWindow = 0;
			await runtime.refresh({ allowNetwork: false, providers: ["faux"] });
			expect(harness.session.model?.contextWindow).toBe(movesEndpoint ? initialWindow : 0);
		},
	);

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
