import { getCurrentTools, normalizeContext } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createBashTool } from "../src/core/tools/bash.ts";
import { createEditTool } from "../src/core/tools/edit.ts";
import { createFindTool } from "../src/core/tools/find.ts";
import { createGrepTool } from "../src/core/tools/grep.ts";
import { createLsTool } from "../src/core/tools/ls.ts";
import { createReadTool } from "../src/core/tools/read.ts";
import { createWriteTool } from "../src/core/tools/write.ts";

describe("native asynchronous built-in tool declarations", () => {
	it("allows the model to continue independent work during file reads and searches", () => {
		const tools = [createReadTool, createGrepTool, createFindTool, createLsTool].map((create) => create("/tmp"));
		const declared = getCurrentTools(normalizeContext({ tools, messages: [] }).messages);
		expect(declared.map((tool) => [tool.name, tool.async])).toEqual([
			["read", true],
			["grep", true],
			["find", true],
			["ls", true],
		]);
	});

	it("waits for shell commands and mutations before continuing model work", () => {
		for (const tool of [createBashTool("/tmp"), createEditTool("/tmp"), createWriteTool("/tmp")]) {
			expect(tool.async).not.toBe(true);
		}
	});
});
