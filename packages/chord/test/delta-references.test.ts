import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../src/context/index.ts";
import { apply, track } from "../src/delta/index.ts";
import { replicatedState } from "../src/index.ts";

type Item = { nested: { x: number }; text: string };
const item = (x: number): Item => ({ nested: { x }, text: "start" });

describe("tracked reference positions", () => {
	for (const action of ["replace", "delete", "undefined", "element", "root"] as const) {
		it(`detaches held descendants after ${action}`, () => {
			const t = track<{ a?: Item; items: Item[] }>({ a: item(1), items: [item(1)] });
			let replica = apply(undefined, t.flush());
			const held = action === "element" ? t.state.items[0]! : t.state.a!;
			const nested = held.nested;
			if (action === "replace") t.state.a = item(2);
			if (action === "delete") delete t.state.a;
			if (action === "undefined") t.state.a = undefined;
			if (action === "element") t.state.items[0] = item(2);
			if (action === "root") t.state = { a: item(2), items: [] };
			replica = apply(replica, t.flush());
			nested.x = 3;
			held.text += " detached";
			expect(nested.x).toBe(3);
			expect(t.flush()).toEqual([]);
			expect(replica).toEqual(t.state);
		});
	}

	for (const readBeforeAlias of [false, true]) {
		it(`publishes nested aliases with descendants read before alias: ${readBeforeAlias}`, () => {
			const state = replicatedState<{ a: Item; b: Item | null }>({ a: item(1), b: null });
			const oldRevision = state.value;
			const nested = readBeforeAlias ? state.state.a.nested : undefined;
			state.state.b = state.state.a;
			(nested ?? state.state.a.nested).x = 2;
			state.publish(BACKGROUND_CONTEXT);
			expect(state.value).toEqual(state.state);
			expect(oldRevision).toEqual({ a: item(1), b: null });
			expect(state.state.a).toBe(state.state.b);
			const held = state.state.a;
			state.state.a = item(10);
			held.nested.x = 3;
			held.text += " aliased";
			state.publish(BACKGROUND_CONTEXT);
			expect(state.value).toEqual({ a: item(10), b: { nested: { x: 3 }, text: "start aliased" } });
			state.state.b = null;
			state.publish(BACKGROUND_CONTEXT);
			held.nested.x = 4;
			state.publish(BACKGROUND_CONTEXT);
			expect(state.value).toEqual(state.state);
		});
	}

	for (const method of ["fill", "copyWithin", "push", "unshift", "splice"] as const) {
		it(`maintains nested array aliases through ${method}, reorder and removal`, () => {
			const state = replicatedState({ items: [item(1), item(2), item(3)] });
			const held = state.state.items[0]!;
			const nested = held.nested;
			if (method === "fill") state.state.items.fill(held);
			if (method === "copyWithin") state.state.items.copyWithin(1, 0, 1);
			if (method === "push") state.state.items.push(held);
			if (method === "unshift") state.state.items.unshift(held);
			if (method === "splice") state.state.items.splice(1, 0, held);
			state.publish(BACKGROUND_CONTEXT);
			nested.x = 4;
			state.publish(BACKGROUND_CONTEXT);
			expect(state.value).toEqual(state.state);
			state.state.items.reverse();
			state.state.items.shift();
			nested.x = 5;
			state.publish(BACKGROUND_CONTEXT);
			expect(state.value).toEqual(state.state);
			state.state.items.length = 0;
			state.publish(BACKGROUND_CONTEXT);
			nested.x = 6;
			state.publish(BACKGROUND_CONTEXT);
			expect(state.value).toEqual({ items: [] });
		});
	}

	it("tracks a fresh fill value at every position without cloning its identity", () => {
		const state = replicatedState({ items: [item(1), item(2)] });
		state.state.items.fill(item(3));
		state.publish(BACKGROUND_CONTEXT);
		expect(state.state.items[0]).toBe(state.state.items[1]);
		state.state.items[0]!.nested.x = 4;
		state.publish(BACKGROUND_CONTEXT);
		expect(state.value).toEqual(state.state);
	});

	it("publishes container replacements beneath aliased parents", () => {
		const state = replicatedState<{ a: Item; b: Item | null }>({ a: item(1), b: null });
		state.state.b = state.state.a;
		state.publish(BACKGROUND_CONTEXT);
		state.state.a.nested = { x: 2 };
		state.publish(BACKGROUND_CONTEXT);
		expect(state.value).toEqual(state.state);
	});

	it("reattaches held descendants after local edits to a detached object", () => {
		const t = track<{ a: Item | null }>({ a: item(1) });
		let replica = apply(undefined, t.flush());
		const held = t.state.a!;
		const oldNested = held.nested;
		t.state.a = null;
		replica = apply(replica, t.flush());
		held.nested = { x: 2 };
		const nextNested = held.nested;
		expect(t.flush()).toEqual([]);
		t.state.a = held;
		nextNested.x = 3;
		oldNested.x = 9;
		replica = apply(replica, t.flush());
		expect(replica).toEqual({ a: { nested: { x: 3 }, text: "start" } });
		expect(replica).toEqual(t.state);
	});

	it("preserves held descendants reused inside replacement containers", () => {
		const t = track({ a: item(1) });
		let replica = apply(undefined, t.flush());
		const nested = t.state.a.nested;
		t.state.a = { ...t.state.a };
		replica = apply(replica, t.flush());
		nested.x = 2;
		replica = apply(replica, t.flush());
		expect(replica).toEqual(t.state);
		t.state = { a: { nested, text: "new root" } };
		replica = apply(replica, t.flush());
		nested.x = 3;
		replica = apply(replica, t.flush());
		expect(replica).toEqual({ a: { nested: { x: 3 }, text: "new root" } });
	});

	it("promotes a held subtree to the root and detaches the outgoing root", () => {
		type Node = { x: number; child?: Node };
		const t = track<Node>({ x: 1, child: { x: 2, child: { x: 3 } } });
		t.flush();
		const oldRoot = t.state;
		const nextRoot = t.state.child!;
		const leaf = nextRoot.child!;
		t.state = nextRoot;
		let replica = apply(undefined, t.flush());
		oldRoot.x = 10;
		leaf.x = 4;
		replica = apply(replica, t.flush());
		expect(replica).toEqual({ x: 2, child: { x: 4 } });
		expect(replica).toEqual(t.state);
	});

	it("propagates mutations and index shifts through aliased arrays", () => {
		const t = track<{ a: Item[]; b: Item[] | null }>({ a: [item(1)], b: null });
		let replica = apply(undefined, t.flush());
		const held = t.state.a[0]!.nested;
		t.state.b = t.state.a;
		t.state.a.unshift(item(2));
		held.x = 3;
		t.state.b![0]!.nested = { x: 4 };
		replica = apply(replica, t.flush());
		expect(replica).toEqual(t.state);
		t.state.a = [];
		t.state.b!.reverse();
		held.x = 5;
		replica = apply(replica, t.flush());
		expect(replica).toEqual(t.state);
	});

	it("coalesces fill and subsequent nested edits in one publication", () => {
		const state = replicatedState({ items: [item(1), item(2)] });
		state.state.items.fill(state.state.items[0]!);
		state.state.items[1]!.nested.x = 3;
		state.publish(BACKGROUND_CONTEXT);
		expect(state.value).toEqual({ items: [item(3), item(3)] });
	});

	it("detaches public replicated-state references on replacement", () => {
		const state = replicatedState({ a: item(1) });
		const held = state.state.a;
		state.state.a = item(2);
		held.nested.x = 3;
		state.publish(BACKGROUND_CONTEXT);
		expect(state.value).toEqual({ a: item(2) });
	});
});
