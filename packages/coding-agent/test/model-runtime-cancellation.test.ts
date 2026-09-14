import {
	type AssistantMessageEvent,
	createModels,
	InMemoryCredentialStore,
	type Models,
	type ModelsSimpleStreamOptions,
	type ProviderHeaders,
} from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { describe, expect, it, vi } from "vitest";
import { ModelRuntime } from "../src/core/model-runtime.ts";

describe.each(["Models", "ModelRuntime"])("%s request setup cancellation", (name) => {
	it.each(["default abort", "custom Error abort", "missing auth"])("preserves %s classification", async (variant) => {
		vi.stubEnv("OPENAI_API_KEY", undefined);
		const credentials = new InMemoryCredentialStore();
		const read = vi.spyOn(credentials, "read");
		const list = vi.spyOn(credentials, "list");
		const modify = vi.spyOn(credentials, "modify");
		const remove = vi.spyOn(credentials, "delete");
		let subject: Models;
		if (name === "Models") {
			const models = createModels({ credentials });
			models.setProvider(openaiProvider());
			subject = models;
		} else {
			subject = await ModelRuntime.create({
				credentials,
				modelsPath: null,
				refreshOnCreate: false,
				allowModelNetwork: false,
			});
		}
		const model = subject.getModel("openai", "gpt-5.4");
		if (!model) throw new Error("Missing native OpenAI model");
		const controller = new AbortController();
		if (variant === "default abort") controller.abort();
		if (variant === "custom Error abort") controller.abort(new Error("controlled custom cancellation"));
		const onPayload = vi.fn();
		const transformHeaders = vi.fn((headers: ProviderHeaders) => headers);
		const fetch = vi.fn(async () => {
			throw new Error("Unexpected provider request");
		});
		const options: ModelsSimpleStreamOptions = { signal: controller.signal, onPayload, transformHeaders, fetch };
		const context = { messages: [] };
		const stream = subject.streamSimple(model, context, options);
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		const message = await stream.result();
		const completion = await subject.completeSimple(model, context, options);
		const reason = controller.signal.aborted ? "aborted" : "error";

		expect(read).toHaveBeenCalledTimes(controller.signal.aborted ? 0 : 2);
		expect(list).not.toHaveBeenCalled();
		expect(modify).not.toHaveBeenCalled();
		expect(remove).not.toHaveBeenCalled();
		expect(onPayload).not.toHaveBeenCalled();
		expect(transformHeaders).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
		expect(events).toEqual([{ type: "error", reason, error: message }]);
		if (events[0]?.type !== "error") throw new Error("Expected one terminal error event");
		expect(events[0].error).toBe(message);
		for (const result of [message, completion]) {
			expect(result).toMatchObject({
				role: "assistant",
				api: model.api,
				provider: model.provider,
				model: model.id,
				stopReason: reason,
				errorMessage: controller.signal.aborted
					? controller.signal.reason.message
					: "Provider is not configured: openai",
				content: [],
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			});
		}
	});
});
