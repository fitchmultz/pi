import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../src/context/index.ts";
import { apply, applyImmutable, track } from "../src/delta/index.ts";
import { replicatedState } from "../src/index.ts";

type Item = { children: number[]; text: string };
type State = { a: Item[]; b: Item[] | null };

describe("aliased operation payload ownership", () => {
	it("publishes a nested push without mutating copied siblings or prior revisions", () => {
		const state = replicatedState<State>({ a: [], b: null });
		const deliveries: State[] = [];
		state.subscribe((value) => deliveries.push(value));
		state.change(BACKGROUND_CONTEXT, (draft) => {
			draft.b = draft.a;
		});
		const previous = state.value;

		state.change(BACKGROUND_CONTEXT, (draft) => {
			draft.a.push({ children: [], text: "x" });
			draft.a[0]!.children.push(1);
		});

		expect(state.value.a).not.toBe(state.value.b);
		expect(state.value).toEqual({
			a: [{ children: [1], text: "x" }],
			b: [],
		});
		expect(deliveries).toHaveLength(3);
		expect(deliveries.at(-1)).toBe(state.value);
		expect(previous).toEqual({ a: [], b: [] });
	});

	for (const applier of [apply, applyImmutable]) {
		for (const insertion of ["push", "splice-all"] as const) {
			for (const flushBetween of [false, true]) {
				for (const mutation of ["children", "text"] as const) {
					it(`${applier.name}: ${insertion}, flush between: ${flushBetween}, edit ${mutation}`, () => {
						const t = track<State>({ a: [], b: null });
						let replica = applier<State>(undefined, t.flush());
						t.state.b = t.state.a;
						replica = applier(replica, t.flush());

						// push emits p; splice covering the whole nested array emits s.
						const item: Item = { children: [], text: "x" };
						if (insertion === "push") t.state.a.push(item);
						else t.state.a.splice(0, t.state.a.length, item);
						if (flushBetween) replica = applier(replica, t.flush());
						if (mutation === "children") t.state.a[0]!.children.push(1);
						else t.state.a[0]!.text += "y";
						replica = applier(replica, t.flush());

						expect(t.state.a).toBe(t.state.b);
						expect(replica).toEqual(t.state);
						// Only the producer aliases: mutable replicas must own each path.
						expect(replica.a[0]).not.toBe(replica.b![0]);
						expect(replica.a[0]!.children).not.toBe(replica.b![0]!.children);
					});
				}
			}
		}
	}
});
