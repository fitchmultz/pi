import { describe, expect, it } from "vitest";
import { getResponsesInputToolCallIds } from "../src/api/openai-responses-shared.ts";

describe("Responses logical input membership", () => {
	it("recognizes function, custom and client search outputs without treating calls as receipts", () => {
		expect(
			getResponsesInputToolCallIds({
				input: [
					{ type: "function_call", call_id: "call", name: "work", arguments: "{}" },
					{ type: "function_call_output", call_id: "function", output: "done" },
					{ type: "custom_tool_call_output", call_id: "custom", output: "done" },
					{ type: "tool_search_output", call_id: "search", execution: "client", tools: [] },
				],
			}),
		).toEqual(["function", "custom", "search"]);
	});

	it.each([[], "plain input", [{ role: "user", content: "hello" }]])(
		"keeps known empty membership for %j",
		(input) => {
			expect(getResponsesInputToolCallIds({ input })).toEqual([]);
		},
	);

	it.each([
		{},
		{ input: [{ type: "item_reference", id: "opaque" }] },
		{ input: [{ type: "compaction", encrypted_content: "opaque represented history" }] },
		{ input: [{ id: "opaque" }] },
		{ input: [{ type: null, id: "opaque" }] },
		{ input: [null] },
		{ input: [{ type: "function_call_output", output: "missing ID" }] },
		{ input: [], previous_response_id: "server-history" },
		{ input: [], conversation: "server-conversation" },
	])("does not infer membership from opaque or invalid input %j", (body) => {
		expect(getResponsesInputToolCallIds(body)).toBeUndefined();
	});
});
