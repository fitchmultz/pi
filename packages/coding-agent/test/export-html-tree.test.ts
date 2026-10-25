import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";
import type { SessionEntry, SessionMessageEntry, SessionTreeNode } from "../src/core/session-manager.ts";

interface FlatNode {
	node: SessionTreeNode;
	indent: number;
	showConnector: boolean;
	isLast: boolean;
	gutters: { position: number; show: boolean }[];
	isVirtualRootChild: boolean;
	multipleRoots: boolean;
}

function loadTree(entries: SessionEntry[], leafId: string) {
	const payload = Buffer.from(
		JSON.stringify({
			header: { type: "session", version: 3, id: "tree-test", timestamp: new Date(0).toISOString(), cwd: "/tmp" },
			entries,
			leafId,
		}),
	).toString("base64");
	const context = createContext({
		atob,
		TextDecoder,
		URLSearchParams,
		document: { getElementById: () => ({ textContent: payload }), querySelector: () => null },
		window: { location: { search: "" } },
	});
	const template = readFileSync(new URL("../src/core/export-html/template.js", import.meta.url), "utf8");
	// Use the same page payload without running the DOM handlers. Browser proof covers those handlers.
	return runInContext(
		template.replace(
			"function renderTree()",
			"return { buildTree, flattenTree, buildActivePathIds, getPath, findNewestLeaf }; function renderTree()",
		),
		context,
	) as {
		buildTree(): SessionTreeNode[];
		flattenTree(roots: SessionTreeNode[], activePathIds: Set<string>): FlatNode[];
		buildActivePathIds(id: string): Set<string>;
		getPath(id: string): SessionEntry[];
		findNewestLeaf(id: string): string;
	};
}

function message(id: string, parentId: string | null, time = 0): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(time).toISOString(),
		message: { role: "user", content: `Message ${id}`, timestamp: time },
	};
}

describe("HTML export tree", () => {
	// Regression for #255. These depths must not consume the JavaScript call stack.
	for (const count of [100, 20_000]) {
		it(`retains every entry and navigates a ${count}-entry chain`, () => {
			const entries = Array.from({ length: count }, (_, i) => message(`m${i}`, i === 0 ? null : `m${i - 1}`));
			const leafId = `m${count - 1}`;
			const view = loadTree(entries, leafId);
			const rows = view.flattenTree(view.buildTree(), view.buildActivePathIds(leafId));

			expect(rows.map((row) => row.node.entry.id)).toEqual(entries.map((entry) => entry.id));
			expect(rows.every((row) => row.indent === 0 && !row.showConnector)).toBe(true);
			expect([...view.buildActivePathIds(leafId)]).toEqual(entries.map((entry) => entry.id).reverse());
			expect(view.getPath(leafId).map((entry) => entry.id)).toEqual(entries.map((entry) => entry.id));
			expect(view.findNewestLeaf("m0")).toBe(leafId);
			expect(view.findNewestLeaf(leafId)).toBe(leafId);
		});
	}

	it("keeps active branches first, timestamps stable, and root order intact", () => {
		const entries = [
			message("other-root", null),
			message("root", null),
			message("latest", "root", 3000),
			message("equal-first", "root", 2000),
			message("active", "root", 1000),
			message("equal-second", "root", 2000),
			message("active-leaf", "active", 4000),
			message("latest-leaf", "latest", 5000),
		];
		const view = loadTree(entries, "active-leaf");
		const roots = view.buildTree();
		expect(roots.map((node) => node.entry.id)).toEqual(["other-root", "root"]);
		expect(roots[1].children.map((node) => node.entry.id)).toEqual([
			"active",
			"equal-first",
			"equal-second",
			"latest",
		]);
		const rows = view.flattenTree(roots, view.buildActivePathIds("active-leaf"));
		expect(rows.map((row) => row.node.entry.id)).toEqual([
			"root",
			"active",
			"active-leaf",
			"equal-first",
			"equal-second",
			"latest",
			"latest-leaf",
			"other-root",
		]);
		expect(rows.map((row) => [row.indent, row.showConnector, row.isLast])).toEqual([
			[1, true, false],
			[2, true, false],
			[3, false, true],
			[2, true, false],
			[2, true, false],
			[2, true, true],
			[3, false, true],
			[1, true, true],
		]);
		expect(view.getPath("active-leaf").map((entry) => entry.id)).toEqual(["root", "active", "active-leaf"]);
		expect(view.findNewestLeaf("root")).toBe("latest-leaf");
		expect(view.findNewestLeaf("active")).toBe("active-leaf");
	});
});
