import type { NestedToolCalls } from "@earendil-works/pi-ai";
import type { ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { computeFileLists, createFileOps, extractFileOpsFromMessage } from "../src/core/compaction/utils.ts";
import type { CustomMessage } from "../src/core/messages.ts";

describe("compaction file operations", () => {
	it("include files touched by nested calls recorded on tool results", () => {
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "codemode-1",
			toolName: "codemode",
			content: [],
			isError: false,
			timestamp: 0,
			nestedCalls: {
				calls: [
					{ id: "codemode-1/1", name: "read", arguments: { path: "a.ts" }, status: "ok" },
					{ id: "codemode-1/2", name: "edit", arguments: { path: "b.ts", edits: [] }, status: "ok" },
					{ id: "codemode-1/3", name: "write", argumentsBytes: 40000, status: "ok" },
				],
				complete: false,
			},
		};
		const fileOps = createFileOps();
		extractFileOpsFromMessage(result, fileOps);
		expect(computeFileLists(fileOps)).toEqual({ readFiles: ["a.ts"], modifiedFiles: ["b.ts"] });
	});

	it("include files touched by a background run, whose calls arrive on its completion message", () => {
		const completion: CustomMessage<{ nestedCalls?: NestedToolCalls }> = {
			role: "custom",
			customType: "codemode-background",
			content: [{ type: "text", text: "Background run codemode-1 completed.\n" }],
			display: true,
			timestamp: 0,
			details: {
				nestedCalls: {
					calls: [
						{ id: "codemode-1/1", name: "read", arguments: { path: "c.ts" }, status: "ok" },
						{ id: "codemode-1/2", name: "write", arguments: { path: "d.ts", content: "" }, status: "ok" },
					],
					complete: true,
				},
			},
		};
		const fileOps = createFileOps();
		extractFileOpsFromMessage(completion, fileOps);
		expect(computeFileLists(fileOps)).toEqual({ readFiles: ["c.ts"], modifiedFiles: ["d.ts"] });
	});
});

describe("foreign custom-message details", () => {
	const foreignDetails: Array<[string, unknown]> = [
		["a calls value that is not an array", { nestedCalls: { calls: { notAnArray: true } } }],
		["a null call element", { nestedCalls: { calls: [null] } }],
	];

	it.each(foreignDetails)("are ignored instead of breaking compaction for %s", (_shape, details) => {
		const message: CustomMessage = {
			role: "custom",
			customType: "other-extension",
			content: [{ type: "text", text: "unrelated" }],
			display: true,
			timestamp: 0,
			details,
		};
		const fileOps = createFileOps();

		expect(() => extractFileOpsFromMessage(message, fileOps)).not.toThrow();
		expect(computeFileLists(fileOps)).toEqual({ readFiles: [], modifiedFiles: [] });
	});
});
