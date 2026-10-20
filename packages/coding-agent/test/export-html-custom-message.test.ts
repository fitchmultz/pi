import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";
import type { CustomMessageEntry } from "../src/core/session-manager.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9foAAAAASUVORK5CYII=";

const completion: CustomMessageEntry = {
	type: "custom_message",
	id: "completion",
	parentId: null,
	timestamp: new Date(0).toISOString(),
	customType: "codemode-background",
	display: true,
	content: [
		{ type: "text", text: "Background run codemode-1 completed.\nScript completed\nOutput:\nhello" },
		{ type: "text", text: "[Image saved to /tmp/a.png (image/png, 1 KB)]" },
		{ type: "image", data: PNG, mimeType: "image/png" },
	],
	details: {
		runId: "codemode-1",
		isError: false,
		nestedCalls: {
			calls: [{ id: "codemode-1/1", name: "read", arguments: { path: "a.ts" }, status: "ok", durationMs: 5 }],
			complete: true,
		},
	},
};

const foreign: CustomMessageEntry = {
	type: "custom_message",
	id: "foreign",
	parentId: null,
	timestamp: new Date(0).toISOString(),
	customType: "other-extension",
	display: true,
	content: [{ type: "text", text: "unrelated" }],
};

function foreignWithNestedCalls(calls: unknown[]): CustomMessageEntry {
	return { ...foreign, details: { nestedCalls: { calls } } };
}

const brokenCoercion = { toString: 5 };

const nonNativeElements: Array<[string, unknown[]]> = [
	["a null element", [null]],
	["a non-string error", [{ name: "read", status: "error", error: 5 }]],
	["an uncoercible name", [{ name: brokenCoercion, status: "ok" }]],
	["an uncoercible status", [{ name: "read", status: brokenCoercion }]],
	["an uncoercible duration", [{ name: "read", status: "ok", durationMs: brokenCoercion }]],
	["an uncoercible argument size", [{ name: "read", status: "ok", argumentsBytes: brokenCoercion }]],
];

// The exported page evaluates template.js in the browser with vendor libraries and the base64
// session payload. Run this checkout's template against the same inputs to observe real output.
function loadRenderEntry(entry: CustomMessageEntry): (entry: CustomMessageEntry) => string {
	const templateDir = new URL("../src/core/export-html/", import.meta.url);
	const read = (name: string) => readFileSync(new URL(name, templateDir), "utf-8");
	const sessionData = Buffer.from(
		JSON.stringify({
			header: { type: "session", version: 3, id: "completion-test", timestamp: new Date(0).toISOString(), cwd: "/" },
			entries: [entry],
			leafId: entry.id,
		}),
	).toString("base64");
	const context = createContext({
		atob,
		TextDecoder,
		URLSearchParams,
		document: { getElementById: () => ({ textContent: sessionData }), querySelector: () => null },
		window: { location: { search: "" } },
	});
	for (const script of ["vendor/marked.min.js", "vendor/marked-cjk-friendly.min.js", "vendor/highlight.min.js"]) {
		runInContext(read(script), context);
	}
	return runInContext(
		read("template.js").replace("function renderEntry(", "return renderEntry; function renderEntry("),
		context,
	);
}

function renderCustomMessage(entry: CustomMessageEntry): string {
	const html = loadRenderEntry(entry)(entry);
	expect(html).toContain("[other-extension]");
	expect(html).toContain("unrelated");
	return html;
}

describe("HTML export of a background completion", () => {
	it("keeps the completion's text, its image, and its nested call record", () => {
		const html = loadRenderEntry(completion)(completion);

		expect(html).toContain("[codemode-background]");
		expect(html).toContain("hello");
		expect(html).toContain('class="message-images"');
		expect(html).toContain(`data:image/png;base64,${PNG}`);
		expect(html).toContain("Nested calls: 1");
		expect(html).toContain("read");
	});

	it("renders a native nested call record with a multiline error and omitted arguments", () => {
		const entry = foreignWithNestedCalls([
			{ name: "edit", status: "error", argumentsBytes: 9000, durationMs: 12, error: "first line\nsecond line" },
		]);
		const html = renderCustomMessage(entry);

		expect(html).toContain("Nested calls: 1");
		expect(html).toContain("[arguments omitted, 9000 bytes]");
		expect(html).toContain("12ms");
		expect(html).toContain("first line");
		expect(html).toContain("second line");
	});

	it("counts only native elements of a nested call record", () => {
		const entry = foreignWithNestedCalls([
			{ name: "grep", status: "ok", arguments: { pattern: "x" } },
			{ name: brokenCoercion, status: "ok" },
		]);
		const html = renderCustomMessage(entry);

		expect(html).toContain("Nested calls: 1");
		expect(html).toContain("grep");
	});

	for (const [label, calls] of nonNativeElements) {
		it(`skips ${label} in a foreign custom message's nested call record`, () => {
			const html = renderCustomMessage(foreignWithNestedCalls(calls));

			expect(html).not.toContain("Nested calls");
		});
	}
});
