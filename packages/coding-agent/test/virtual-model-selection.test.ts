import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { createVirtualModel, getBranchSelection } from "../src/core/virtual-models.ts";

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
		for (const branch of [manager.getBranch(), manager.iterateEntryMetadata({ branchFrom: manager.getLeafId() })]) {
			getModel.mockClear();
			expect(getBranchSelection(branch, getModel)).toEqual({ provider: "catalog", modelId: expected });
			expect(getModel).toHaveBeenCalledTimes(1);
		}
		manager.appendModelChange("catalog", "new-selection");
		getModel.mockClear();
		expect(getBranchSelection(manager.getBranch(), getModel)).toEqual({
			provider: "catalog",
			modelId: "new-selection",
		});
		expect(getModel).not.toHaveBeenCalled();
	},
);

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
	expect(getBranchSelection(manager.getBranch(), getModel)).toEqual({ provider: "catalog", modelId: "latest" });
	expect(getModel).toHaveBeenCalledExactlyOnceWith("catalog", "physical");
	expect(getBranchSelection([], getModel)).toBeUndefined();
});
