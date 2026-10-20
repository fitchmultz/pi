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
	details: { nestedCalls: { calls: [null] } },
};

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

	it("ignores a foreign custom message's malformed nested call record", () => {
		const render = loadRenderEntry(foreign);
		let html = "";
		expect(() => {
			html = render(foreign);
		}).not.toThrow();
		expect(html).toContain("[other-extension]");
		expect(html).toContain("unrelated");
		expect(html).not.toContain("Nested calls");
	});
});
