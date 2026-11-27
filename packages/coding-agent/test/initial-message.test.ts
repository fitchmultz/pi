import { describe, expect, test } from "vitest";
import type { Args } from "../src/cli/args.ts";
import { buildInitialMessage } from "../src/cli/initial-message.ts";

function createArgs(messages: string[] = []): Args {
	return {
		messages: [...messages],
		fileArgs: [],
		unknownFlags: new Map(),
		resumeFlags: [],
		diagnostics: [],
	};
}

describe("buildInitialMessage", () => {
	test("merges piped stdin with the first CLI message into one prompt", () => {
		const parsed = createArgs(["Summarize the text given"]);
		const result = buildInitialMessage({
			parsed,
			stdinContent: "README contents",
		});

		expect(result.initialMessage).toBe("README contents\n\nSummarize the text given");
		expect(parsed.messages).toEqual([]);
	});

	test("avoids triple newlines when stdin already ends with a newline", () => {
		const parsed = createArgs(["Summarize the text given"]);
		const result = buildInitialMessage({
			parsed,
			stdinContent: "README contents\n",
		});

		expect(result.initialMessage).toBe("README contents\n\nSummarize the text given");
		expect(parsed.messages).toEqual([]);
	});

	test("uses stdin as the initial prompt when no CLI message is present", () => {
		const parsed = createArgs();
		const result = buildInitialMessage({
			parsed,
			stdinContent: "README contents",
		});

		expect(result.initialMessage).toBe("README contents");
		expect(parsed.messages).toEqual([]);
	});

	test("combines stdin, file text, and first CLI message in one prompt", () => {
		const parsed = createArgs(["Explain it", "Second message"]);
		const result = buildInitialMessage({
			parsed,
			stdinContent: "stdin\n",
			fileText: "file\n",
		});

		expect(result.initialMessage).toBe("stdin\n\nfile\n\nExplain it");
		expect(parsed.messages).toEqual(["Second message"]);
	});

	test("does not pile up extra blank lines when parts already carry blank-line boundaries", () => {
		const result = buildInitialMessage({
			parsed: createArgs(["\nExplain it"]),
			stdinContent: "stdin\n\n",
			fileText: "file\n",
		});
		expect(result.initialMessage).toBe("stdin\n\nfile\n\nExplain it");
	});

	test("ignores empty stdin when a CLI message is present", () => {
		const result = buildInitialMessage({
			parsed: createArgs(["Explain it"]),
			stdinContent: "",
		});
		expect(result.initialMessage).toBe("Explain it");
	});

	test("preserves non-empty whitespace stdin when a CLI message is present", () => {
		const result = buildInitialMessage({
			parsed: createArgs(["Count the spaces"]),
			stdinContent: "  ",
		});
		expect(result.initialMessage).toBe("  \n\nCount the spaces");
	});

	test("does not start a turn for whitespace-only combined input", () => {
		const result = buildInitialMessage({
			parsed: createArgs([" \t"]),
			stdinContent: "\n ",
			fileText: " \r\n",
		});
		expect(result.initialMessage).toBeUndefined();
	});
});
