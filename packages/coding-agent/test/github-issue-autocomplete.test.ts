import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AutocompleteProvider, CombinedAutocompleteProvider, Editor } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import { TuiMainScreen } from "../../tui/src/tui-main-screen.ts";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import githubIssueAutocomplete from "../examples/extensions/github-issue-autocomplete.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";

async function issueWrapper(cwd: string): Promise<(current: AutocompleteProvider) => AutocompleteProvider> {
	const on = vi.fn();
	const addAutocompleteProvider = vi.fn();
	githubIssueAutocomplete({
		on,
		exec: async (command: string) => ({
			code: 0,
			stdout: command === "git" ? "origin git@github.com:owner/repo.git (fetch)\n" : "[]",
			stderr: "",
		}),
	} as unknown as ExtensionAPI);
	const start = on.mock.calls[0][1] as (event: unknown, context: unknown) => Promise<void>;
	await start({}, { cwd, ui: { addAutocompleteProvider, notify: vi.fn() } });
	return addAutocompleteProvider.mock.calls[0][0] as (current: AutocompleteProvider) => AutocompleteProvider;
}

const payload = Array.from({ length: 12 }, (_, i) => `hidden-${i}`).join("\n");

function editor(provider: AutocompleteProvider): Editor {
	const target = new Editor(new TuiMainScreen(new VirtualTerminal(100, 24)), defaultEditorTheme);
	target.setAutocompleteProvider(provider);
	return target;
}

test("the bundled issue wrapper preserves native scoped absolute-path completion", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-issue-wrapper-"));
	try {
		const file = join(directory, "source.ts");
		writeFileSync(file, "");
		const native = new CombinedAutocompleteProvider([], directory);
		const suggestions = vi.spyOn(native, "getSuggestions");
		const wrapper = await issueWrapper(directory);
		const wrapped = wrapper(native);
		expect(wrapped.inputContext).toBe("line");
		const target = editor(wrapped);
		target.handleInput(`\x1b[200~${payload}\x1b[201~`);
		const prefix = join(directory, "sou");
		target.insertTextAtCursor(`\n${prefix}`);
		target.handleInput("\t");
		await new Promise((resolve) => setImmediate(resolve));
		expect(target.getText()).toBe(`${payload}\n${file.replaceAll("\\", "/")}`);
		expect(suggestions).toHaveBeenCalledWith(
			[prefix],
			0,
			prefix.length,
			expect.objectContaining({ force: true, slashCommands: false }),
		);
		expect(target.render(100).join("\n")).toContain("[paste #1");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("the bundled issue wrapper retains undeclared providers' full-document transformations", async () => {
	const wrapper = await issueWrapper(tmpdir());
	const original = `before\n${payload}\nquery`;
	const expected = original.replace("before", "BEFORE");
	const provider: AutocompleteProvider = {
		getSuggestions: vi.fn(async () => ({ prefix: "query", items: [{ value: "transform", label: "transform" }] })),
		applyCompletion: () => ({ lines: expected.split("\n"), cursorLine: 13, cursorCol: 5 }),
		shouldTriggerFileCompletion: vi.fn(() => true),
	};
	const wrapped = wrapper(provider);
	expect(wrapped.inputContext).toBeUndefined();
	const target = editor(wrapped);
	target.setText("before\n");
	target.handleInput(`\x1b[200~${payload}\x1b[201~`);
	target.insertTextAtCursor("\nquery");
	target.handleInput("\t");
	await new Promise((resolve) => setImmediate(resolve));
	expect(target.getText()).toBe(expected);
	expect(provider.getSuggestions).toHaveBeenCalledWith(
		original.split("\n"),
		13,
		5,
		expect.objectContaining({ force: true, slashCommands: false }),
	);
	expect(provider.shouldTriggerFileCompletion).toHaveBeenCalledWith(original.split("\n"), 13, 5, {
		slashCommands: false,
	});
	expect(target.render(100).join("\n")).toContain("[paste #1");
});
