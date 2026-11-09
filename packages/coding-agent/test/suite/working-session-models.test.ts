import { describe, expect, it } from "vitest";
import { createAgentSession } from "../../src/core/sdk.ts";
import { createHarness } from "./harness.ts";

describe("working-session model restoration", () => {
	it("omits a removed cycling model without changing the selected model or saved state", async () => {
		const h = await createHarness({ models: [{ id: "selected" }, { id: "removed" }] });
		try {
			const selected = h.getModel();
			const removed = h.getModel("removed")!;
			h.session.setScopedModels([{ model: removed }, { model: selected, thinkingLevel: "off" }]);
			const hold = await h.session.acquireWorkingSession();
			await hold.release();
			const before = structuredClone(hold.state);
			const runtime = h.session.modelRuntime;
			runtime.registerProvider(selected.provider, { models: [selected] });
			expect(runtime.getModel(removed.provider, removed.id)).toBeUndefined();
			const { session } = await createAgentSession({
				workingSession: hold.state,
				modelRuntime: runtime,
				resourceLoader: h.session.resourceLoader,
			});
			try {
				expect(session.model).toMatchObject({ provider: selected.provider, id: selected.id });
				expect(session.scopedModels).toMatchObject([{ model: { id: selected.id }, thinkingLevel: "off" }]);
				expect(session.sessionId).toBe(h.session.sessionId);
				expect(hold.state).toEqual(before);
			} finally {
				session.dispose();
			}
			await expect(
				createAgentSession({
					workingSession: { ...hold.state, model: { provider: removed.provider, id: removed.id } },
					modelRuntime: runtime,
					resourceLoader: h.session.resourceLoader,
				}),
			).rejects.toThrow(`Saved model ${removed.provider}/${removed.id} is not registered`);
		} finally {
			h.cleanup();
		}
	});
});
