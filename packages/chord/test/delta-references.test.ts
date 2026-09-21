import { describe, expect, it } from "vitest";
import { apply, applyImmutable, track } from "../src/delta/index.ts";

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
			const state = track<{ a: Item; b: Item | null }>({ a: item(1), b: null });
			let replica = applyImmutable<typeof state.state>(undefined, state.flush());
			const oldRevision = replica;
			const nested = readBeforeAlias ? state.state.a.nested : undefined;
			state.state.b = state.state.a;
			(nested ?? state.state.a.nested).x = 2;
			replica = applyImmutable(replica, state.flush());
			expect(replica).toEqual(state.state);
			expect(oldRevision).toEqual({ a: item(1), b: null });
			expect(state.state.a).toBe(state.state.b);
			const held = state.state.a;
			state.state.a = item(10);
			held.nested.x = 3;
			held.text += " aliased";
			replica = applyImmutable(replica, state.flush());
			expect(replica).toEqual({ a: item(10), b: { nested: { x: 3 }, text: "start aliased" } });
			state.state.b = null;
			replica = applyImmutable(replica, state.flush());
			held.nested.x = 4;
			replica = applyImmutable(replica, state.flush());
			expect(replica).toEqual(state.state);
		});
	}

	for (const method of ["fill", "copyWithin", "push", "unshift", "splice"] as const) {
		it(`maintains nested array aliases through ${method}, reorder and removal`, () => {
			const state = track({ items: [item(1), item(2), item(3)] });
			let replica = applyImmutable<typeof state.state>(undefined, state.flush());
			const held = state.state.items[0]!;
			const nested = held.nested;
			if (method === "fill") state.state.items.fill(held);
			if (method === "copyWithin") state.state.items.copyWithin(1, 0, 1);
			if (method === "push") state.state.items.push(held);
			if (method === "unshift") state.state.items.unshift(held);
			if (method === "splice") state.state.items.splice(1, 0, held);
			replica = applyImmutable(replica, state.flush());
			nested.x = 4;
			replica = applyImmutable(replica, state.flush());
			expect(replica).toEqual(state.state);
			state.state.items.reverse();
			state.state.items.shift();
			nested.x = 5;
			replica = applyImmutable(replica, state.flush());
			expect(replica).toEqual(state.state);
			state.state.items.length = 0;
			replica = applyImmutable(replica, state.flush());
			nested.x = 6;
			replica = applyImmutable(replica, state.flush());
			expect(replica).toEqual({ items: [] });
		});
	}

	it("tracks a fresh fill value at every position without cloning its identity", () => {
		const state = track({ items: [item(1), item(2)] });
		let replica = applyImmutable<typeof state.state>(undefined, state.flush());
		state.state.items.fill(item(3));
		replica = applyImmutable(replica, state.flush());
		expect(state.state.items[0]).toBe(state.state.items[1]);
		state.state.items[0]!.nested.x = 4;
		replica = applyImmutable(replica, state.flush());
		expect(replica).toEqual(state.state);
	});

	it("publishes container replacements beneath aliased parents", () => {
		const state = track<{ a: Item; b: Item | null }>({ a: item(1), b: null });
		let replica = applyImmutable<typeof state.state>(undefined, state.flush());
		state.state.b = state.state.a;
		replica = applyImmutable(replica, state.flush());
		state.state.a.nested = { x: 2 };
		replica = applyImmutable(replica, state.flush());
		expect(replica).toEqual(state.state);
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
		const state = track({ items: [item(1), item(2)] });
		const previous = applyImmutable<typeof state.state>(undefined, state.flush());
		state.state.items.fill(state.state.items[0]!);
		state.state.items[1]!.nested.x = 3;
		const replica = applyImmutable(previous, state.flush());
		expect(replica).toEqual({ items: [item(3), item(3)] });
	});

	it("reuses positions after renumbering children first read out of index order", () => {
		const t = track<{ a: Item[]; b: Item[] | null }>({ a: [item(0), item(1), item(2), item(3)], b: null });
		let replica = apply<typeof t.state>(undefined, t.flush());
		const held = [2, 0, 3, 1].map((index) => t.state.a[index]!);
		t.state.b = t.state.a;
		t.state.a.splice(1, 0, item(4));
		for (const [i, index] of [3, 0, 4, 2].entries()) {
			expect(t.state.a[index]).toBe(held[i]);
			held[i]!.nested.x += 10;
		}
		replica = apply(replica, t.flush());
		expect(replica).toEqual(t.state);

		t.state.b!.splice(0, 2);
		for (const [i, index] of [1, -1, 2, 0].entries()) {
			if (index >= 0) expect(t.state.a[index]).toBe(held[i]);
			held[i]!.nested.x += 10;
		}
		replica = apply(replica, t.flush());
		expect(replica).toEqual(t.state);
		t.state.a[1] = item(5);
		held[0]!.nested.x = 99; // re-reading after shifts must not leave a duplicate live cell
		replica = apply(replica, t.flush());
		expect(replica).toEqual(t.state);
		expect(replica.a[1]).toEqual(item(5));
	});

	it("detaches tracked references on replacement within one publication", () => {
		const state = track({ a: item(1) });
		const previous = applyImmutable<typeof state.state>(undefined, state.flush());
		const held = state.state.a;
		state.state.a = item(2);
		held.nested.x = 3;
		const replica = applyImmutable(previous, state.flush());
		expect(replica).toEqual({ a: item(2) });
	});
});
