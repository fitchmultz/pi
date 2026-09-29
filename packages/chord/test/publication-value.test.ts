import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../src/context/index.ts";
import { replicatedState } from "../src/index.ts";

type Item = { children: number[]; text: string };
type State = { a: Item[]; b: Item[] | null };

describe("published value ownership", () => {
	it("publishes a nested insertion without mutating copied siblings or prior revisions", () => {
		const state = replicatedState<State>({ a: [], b: null });
		const deliveries: State[] = [];
		const unsubscribe = state.subscribe((value) => deliveries.push(value));
		state.change(BACKGROUND_CONTEXT, (draft) => {
			draft.b = draft.a;
		});
		const previous = state.value;
		state.change(BACKGROUND_CONTEXT, (draft) => {
			draft.a.push({ children: [], text: "x" });
			draft.a[0]!.children.push(1);
		});
		expect(state.value.a).not.toBe(state.value.b);
		expect(state.value).toEqual({ a: [{ children: [1], text: "x" }], b: [] });
		expect(deliveries).toHaveLength(3);
		expect(deliveries.at(-1)).toBe(state.value);
		expect(previous).toEqual({ a: [], b: [] });
		unsubscribe();
	});
});
