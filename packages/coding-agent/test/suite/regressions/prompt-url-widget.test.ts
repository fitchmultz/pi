import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, onTestFinished, test, vi } from "vitest";
import promptUrlWidgetExtension from "../../../../../.pi/extensions/prompt-url-widget.ts";
import { createHarness, createTestUiContext } from "../harness.ts";

test("prompt URL widget keeps the user's target when a background message starts a run", async () => {
	const exec = vi.fn(async () => ({
		stdout: JSON.stringify({ title: "Example change" }),
		stderr: "",
		code: 0,
		killed: false,
	}));
	const onError = vi.fn();
	const setWidget = vi.fn();
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.exec = exec;
				promptUrlWidgetExtension(pi);
			},
		],
	});
	onTestFinished(() => harness.cleanup());
	await harness.session.bindExtensions({ uiContext: createTestUiContext({ setWidget }), onError });
	harness.setResponses([fauxAssistantMessage("ready"), fauxAssistantMessage("background handled")]);

	await harness.session.prompt("You are given one or more GitHub PR URLs:\nhttps://github.com/example/repo/pull/1");
	expect(onError).not.toHaveBeenCalled();
	expect(setWidget).toHaveBeenLastCalledWith("prompt-url", expect.any(Function));
	expect(harness.sessionManager.getSessionName()).toBe("PR: Example change (https://github.com/example/repo/pull/1)");
	exec.mockClear();
	setWidget.mockClear();

	await harness.session.sendCustomMessage(
		{
			customType: "task-done",
			content: "You are given one or more GitHub PR URLs:\nhttps://github.com/example/repo/pull/2",
			display: true,
		},
		{ triggerTurn: true },
	);

	expect(onError).not.toHaveBeenCalled();
	expect(setWidget).not.toHaveBeenCalled();
	expect(exec).not.toHaveBeenCalled();
	expect(harness.sessionManager.getSessionName()).toBe("PR: Example change (https://github.com/example/repo/pull/1)");
	expect(harness.faux.state.callCount).toBe(2);
});
