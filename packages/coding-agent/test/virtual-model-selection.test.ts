import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { createVirtualModel, getSessionSelection } from "../src/core/virtual-models.ts";

// Upstream #10198: model selection must not query a refreshed catalog for every saved response.
it.each([
	{ selected: "physical", registered: false, expected: "latest" },
	{ selected: "router", registered: true, expected: "router" },
	{ selected: "router", registered: false, expected: "latest" },
])(
	"resolves a long branch with one catalog query ($selected, registered=$registered)",
	({ selected, registered, expected }) => {
		const manager = SessionManager.inMemory();
		manager.appendModelChange("catalog", selected);
		for (let index = 0; index < 1000; index++) {
			manager.appendMessage({ ...fauxAssistantMessage("answer"), provider: "catalog", model: "latest" });
		}
		const virtual = createVirtualModel({ provider: "catalog", id: "router", name: "Router" });
		const getModel = vi.fn(() => (registered ? virtual : undefined));
		for (let read = 0; read < 2; read++) {
			getModel.mockClear();
			expect(getSessionSelection(manager, getModel)).toEqual({ provider: "catalog", modelId: expected });
			expect(getModel).toHaveBeenCalledTimes(1);
		}
		manager.appendModelChange("catalog", "new-selection");
		getModel.mockClear();
		expect(getSessionSelection(manager, getModel)).toEqual({
			provider: "catalog",
			modelId: "new-selection",
		});
		expect(getModel).not.toHaveBeenCalled();
	},
);

it("returns independent selections and refreshes catalog and branch changes after hydration", () => {
	const manager = SessionManager.inMemory();
	const virtual = createVirtualModel({ provider: "catalog", id: "router", name: "Router" });
	let registered = true;
	const getModel = () => (registered ? virtual : undefined);
	const root = manager.appendModelChange("catalog", "router");
	manager.appendMessage({ ...fauxAssistantMessage("routed"), provider: "catalog", model: "first" });
	const first = getSessionSelection(manager, getModel)!;
	first.modelId = "mutated";
	expect(getSessionSelection(manager, getModel)).toEqual({ provider: "catalog", modelId: "router" });
	registered = false;
	expect(getSessionSelection(manager, getModel)).toEqual({ provider: "catalog", modelId: "first" });
	manager.appendMessage({ ...fauxAssistantMessage("next"), provider: "catalog", model: "second" });
	expect(getSessionSelection(manager, getModel)).toEqual({ provider: "catalog", modelId: "second" });
	manager.branch(root);
	expect(getSessionSelection(manager, getModel)).toEqual({ provider: "catalog", modelId: "router" });
	manager.appendModelChange("catalog", "sibling");
	expect(getSessionSelection(manager, getModel)).toEqual({ provider: "catalog", modelId: "sibling" });
});

it("does not let an older virtual selection survive a later physical selection or failed virtual response", () => {
	const manager = SessionManager.inMemory();
	manager.appendModelChange("catalog", "router");
	manager.appendMessage({ ...fauxAssistantMessage("routed"), provider: "catalog", model: "first" });
	manager.appendModelChange("catalog", "physical");
	manager.appendMessage({ ...fauxAssistantMessage("physical"), provider: "catalog", model: "latest" });
	manager.appendMessage({
		...fauxAssistantMessage("", { stopReason: "error" }),
		provider: "catalog",
		model: "router",
		api: "pi-virtual",
	});
	const virtual = createVirtualModel({ provider: "catalog", id: "router", name: "Router" });
	const getModel = vi.fn((_: string, id: string) => (id === "router" ? virtual : undefined));
	expect(getSessionSelection(manager, getModel)).toEqual({ provider: "catalog", modelId: "latest" });
	expect(getModel).toHaveBeenCalledExactlyOnceWith("catalog", "physical");
	expect(getSessionSelection(SessionManager.inMemory(), getModel)).toBeUndefined();
});
