import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CombinedAutocompleteProvider } from "../src/autocomplete.ts";
import { Editor } from "../src/components/editor.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

describe("CombinedAutocompleteProvider slash-command filter", () => {
	const commands = [
		{ name: "skill:deep-research", description: "Multi-agent deep research" },
		{ name: "skill:research-idea", description: "Refine a raw idea into a falsifiable seed" },
		{ name: "skill:to-sidecar", description: "Route work to a sidecar" },
		{ name: "model", description: "Select the active model" },
	];

	async function suggestionsFor(prefix: string): Promise<string[]> {
		const provider = new CombinedAutocompleteProvider(commands, process.cwd());
		const line = `/${prefix}`;
		const result = await provider.getSuggestions([line], 0, line.length, {
			signal: new AbortController().signal,
		});
		assert.ok(result, `expected suggestions for "/${prefix}"`);
		return result.items.map((item) => item.value);
	}

	it("ranks skill:research-idea first for query 'idea'", async () => {
		const items = await suggestionsFor("idea");
		assert.equal(items[0], "skill:research-idea");
		assert.ok(!items.includes("skill:deep-research"));
	});

	it("keeps ordinary slash commands matching", async () => {
		const items = await suggestionsFor("mod");
		assert.ok(items.includes("model"));
	});

	it("keeps explicit skill: queries working", async () => {
		const items = await suggestionsFor("skill:side");
		assert.ok(items.includes("skill:to-sidecar"));
	});

	it("declares editable-line input and can suppress globally ineligible slash commands", async () => {
		const provider = new CombinedAutocompleteProvider(commands, process.cwd());
		assert.equal(provider.inputContext, "line");
		const result = await provider.getSuggestions(["/skill:side"], 0, 11, {
			signal: new AbortController().signal,
			slashCommands: false,
		});
		assert.equal(result, null);
	});

	it("applies root-level absolute paths without slash-command formatting", () => {
		const provider = new CombinedAutocompleteProvider(commands, process.cwd());
		assert.deepEqual(provider.applyCompletion(["/tm"], 0, 3, { value: "/tmp/", label: "tmp/" }, "/tm"), {
			lines: ["/tmp/"],
			cursorLine: 0,
			cursorCol: 5,
		});
		assert.deepEqual(provider.applyCompletion(["/tm"], 0, 3, { value: '"/tmp dir/"', label: "tmp dir/" }, "/tm"), {
			lines: ['"/tmp dir/"'],
			cursorLine: 0,
			cursorCol: 10,
		});
	});

	it(
		"requires force for slash-ineligible absolute paths that have filesystem matches",
		{ skip: process.platform === "win32" },
		async () => {
			const directory = mkdtempSync(join(tmpdir(), "pi-autocomplete-slash-"));
			try {
				const file = join(directory, "source.ts");
				writeFileSync(file, "");
				const provider = new CombinedAutocompleteProvider(commands, directory);
				const options = { signal: new AbortController().signal, slashCommands: false };
				for (const prefix of [join(directory, "sou"), `  ${join(directory, "sou")}`]) {
					const forced = await provider.getSuggestions([prefix], 0, prefix.length, { ...options, force: true });
					assert.deepEqual(
						forced?.items.map((item) => item.value),
						[file],
					);
					for (const force of [undefined, false]) {
						assert.equal(await provider.getSuggestions([prefix], 0, prefix.length, { ...options, force }), null);
					}
				}
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		},
	);

	it(
		"closes a regular picker when paging down onto a slash-ineligible path",
		{ skip: process.platform === "win32" },
		async () => {
			const directory = mkdtempSync(join(tmpdir(), "pi-editor-slash-"));
			try {
				writeFileSync(join(directory, "source.ts"), "");
				const prefix = join(directory, "sou");
				const command = "x".repeat(prefix.length - 1);
				const width = prefix.length + 10;
				const editor = new Editor(new TuiMainScreen(new VirtualTerminal(width, 24)), defaultEditorTheme);
				editor.setAutocompleteProvider(new CombinedAutocompleteProvider([{ name: command }], directory));
				editor.setText(`/${command}\n${prefix}`);
				editor.render(width);
				editor.handleInput("\x1b[A");
				editor.handleInput("\t");
				await new Promise((resolve) => setImmediate(resolve));
				assert.equal(editor.isShowingAutocomplete(), true);

				editor.handleInput("\x1b[6~");
				await new Promise((resolve) => setImmediate(resolve));
				assert.deepEqual(editor.getCursor(), { line: 1, col: prefix.length });
				assert.equal(editor.isShowingAutocomplete(), false);
				editor.handleInput("\t");
				await new Promise((resolve) => setImmediate(resolve));
				assert.equal(editor.getText(), `/${command}\n${join(directory, "source.ts")}`);
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		},
	);

	it("suppresses command arguments without turning natural completion into forced file completion", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-autocomplete-context-"));
		try {
			writeFileSync(join(directory, "source.ts"), "");
			let argumentCalls = 0;
			const provider = new CombinedAutocompleteProvider(
				[
					{
						name: "model",
						getArgumentCompletions: () => {
							argumentCalls++;
							return [{ value: "sonnet", label: "sonnet" }];
						},
					},
				],
				directory,
			);
			const line = "/model so";
			const signal = new AbortController().signal;
			const normal = await provider.getSuggestions([line], 0, line.length, { signal });
			assert.equal(normal?.items[0].value, "sonnet");
			assert.equal(argumentCalls, 1);

			const scoped = await provider.getSuggestions([line], 0, line.length, { signal, slashCommands: false });
			assert.equal(scoped, null);
			assert.equal(argumentCalls, 1);

			const forced = await provider.getSuggestions([line], 0, line.length, {
				signal,
				slashCommands: false,
				force: true,
			});
			assert.equal(forced?.items[0].value, "source.ts");
			assert.equal(argumentCalls, 1);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
