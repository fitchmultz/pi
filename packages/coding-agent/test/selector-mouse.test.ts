import type { Model } from "@earendil-works/pi-ai";
import {
	type Component,
	ScrollView,
	SettingsList,
	setKeybindings,
	Text,
	type TUI,
	TuiAltScreen,
	VStack,
} from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { ExtensionCommandContext, ExtensionUIContext } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import type { SessionInfo, SessionTreeNode } from "../src/core/session-manager.ts";
import { SETTINGS_DEFAULTS } from "../src/core/settings-defaults.ts";
import { showLlamaUi } from "../src/extensions/llama/ui.ts";
import { McpManagerView } from "../src/extensions/mcp/ui.ts";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { OAuthSelectorComponent } from "../src/modes/interactive/components/oauth-selector.ts";
import { createLoginMenuSelector } from "../src/modes/interactive/components/radius-login-selector.ts";
import { ScopedModelsSelectorComponent } from "../src/modes/interactive/components/scoped-models-selector.ts";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.ts";
import {
	type SettingsCallbacks,
	SettingsSelectorComponent,
} from "../src/modes/interactive/components/settings-selector.ts";
import { SteppedSubmenu } from "../src/modes/interactive/components/settings-submenu.ts";
import { ShowImagesSelectorComponent } from "../src/modes/interactive/components/show-images-selector.ts";
import { ThemeSelectorComponent } from "../src/modes/interactive/components/theme-selector.ts";
import { ThinkingSelectorComponent } from "../src/modes/interactive/components/thinking-selector.ts";
import { TreeSelectorComponent } from "../src/modes/interactive/components/tree-selector.ts";
import { TrustSelectorComponent } from "../src/modes/interactive/components/trust-selector.ts";
import { UserMessageSelectorComponent } from "../src/modes/interactive/components/user-message-selector.ts";
import { getSettingsListTheme, initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

const keybindings = new KeybindingsManager();
const selectItems = (labels: string[]) => labels.map((label) => ({ value: label, label }));

async function withSelector(
	create: (
		tui: TUI,
	) => { component: Component; focus?: Component } | Promise<{ component: Component; focus?: Component }>,
	run: (terminal: VirtualTerminal) => Promise<void>,
	columns = 50,
): Promise<void> {
	const terminal = new VirtualTerminal(columns, 42);
	const tui = new TuiAltScreen(terminal);
	const { component, focus = component } = await create(tui);
	const transcript = new ScrollView(
		new Text(Array.from({ length: 50 }, (_, i) => `Transcript ${i + 1}`).join("\n"), 0, 0),
		{
			primary: true,
			follow: "end",
		},
	);
	tui.setLayoutRoot(new VStack([{ component: transcript, basis: 0, grow: 1, minSize: 1 }, component]));
	tui.setFocus(focus);
	tui.start();
	try {
		await terminal.waitForRender();
		await run(terminal);
	} finally {
		tui.stop();
	}
}

function findRow(terminal: VirtualTerminal, text: string): number {
	const index = terminal.getViewport().findIndex((line) => line.includes(text));
	expect(index, `missing row: ${text}\n${terminal.getViewport().join("\n")}`).toBeGreaterThanOrEqual(0);
	return index + 1;
}

function wheel(terminal: VirtualTerminal, row: number, direction: "up" | "down"): void {
	terminal.sendInput(`\x1b[<${direction === "up" ? 64 : 65};3;${row}M`);
}

function press(terminal: VirtualTerminal, row: number, column = 3): void {
	terminal.sendInput(`\x1b[<0;${column};${row}M`);
}

function release(terminal: VirtualTerminal, row: number, column = 3): void {
	terminal.sendInput(`\x1b[<0;${column};${row}m`);
}

function tap(terminal: VirtualTerminal, row: number, column = 3): void {
	press(terminal, row, column);
	release(terminal, row, column);
}

async function prependInInput(terminal: VirtualTerminal, value: string, prefix: string): Promise<number> {
	terminal.sendInput(value);
	await terminal.waitForRender();
	tap(terminal, findRow(terminal, `> ${value}`));
	terminal.sendInput(prefix);
	await terminal.waitForRender();
	return findRow(terminal, `> ${prefix}${value}`);
}

function model(id: string, name = id): Model<"openai-completions"> {
	return {
		id,
		name,
		api: "openai-completions",
		provider: "example",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 1024,
	};
}

function session(id: string, name: string, order: number): SessionInfo {
	return {
		id,
		name,
		path: `/tmp/${id}.jsonl`,
		cwd: "",
		created: new Date(order),
		modified: new Date(order),
		messageCount: 1,
		firstMessage: name,
		allMessagesText: name,
	};
}

function treeNode(id: string, text: string, parentId: string | null = null): SessionTreeNode {
	return {
		entry: {
			type: "message",
			id,
			parentId,
			timestamp: new Date(0).toISOString(),
			message: { role: "user", content: text, timestamp: 0 },
		},
		children: [],
	};
}

describe("fullscreen selector mouse input", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(keybindings);
	});

	it("scrolls extension choices over the header, clamps at both ends, and only selects on release", async () => {
		const select = vi.fn();
		const component = new ExtensionSelectorComponent("Pick a fruit", ["Apple", "Banana"], select, vi.fn());
		await withSelector(
			() => ({ component }),
			async (terminal) => {
				const header = findRow(terminal, "Pick a fruit");
				wheel(terminal, header, "up");
				await terminal.waitForRender();
				findRow(terminal, "Transcript 50");
				findRow(terminal, "→ Apple");
				wheel(terminal, header, "down");
				await terminal.waitForRender();
				findRow(terminal, "→ Banana");
				// A leaked down-wheel would be invisible with the transcript already at the newest line.
				wheel(terminal, findRow(terminal, "Transcript 50"), "up");
				await terminal.waitForRender();
				const olderLine = terminal.getViewport()[0];
				wheel(terminal, header, "down");
				await terminal.waitForRender();
				findRow(terminal, "→ Banana");
				expect(terminal.getViewport()[0]).toBe(olderLine);
				const apple = findRow(terminal, "Apple");
				press(terminal, apple);
				await terminal.waitForRender();
				findRow(terminal, "→ Apple");
				expect(select).not.toHaveBeenCalled();
				release(terminal, apple);
				expect(select).toHaveBeenCalledExactlyOnceWith("Apple");
			},
		);
	});

	it("keeps the animated Radius sign-in option clickable", async () => {
		const select = vi.fn();
		const radius = "Sign in with Radius";
		await withSelector(
			(tui) => ({
				component: createLoginMenuSelector(
					tui,
					"Sign in",
					["Other", radius],
					{ label: radius, text: radius },
					select,
					vi.fn(),
				),
			}),
			async (terminal) => {
				wheel(terminal, findRow(terminal, "Sign in"), "down");
				await terminal.waitForRender();
				const row = findRow(terminal, `→ ${radius}`);
				tap(terminal, row);
				expect(select).toHaveBeenCalledExactlyOnceWith(radius);
			},
		);
	});

	it("scrolls over model search and selects a model from a wrapped continuation row", async () => {
		const models = [
			model("model-a"),
			model("model-b", "A deliberately long model name that wraps through BrightContinuation"),
		];
		const runtime: Pick<ModelRuntime, "getAvailableSnapshot" | "refresh" | "getError"> = {
			getAvailableSnapshot: () => models,
			refresh: async () => ({ aborted: false, errors: new Map() }),
			getError: () => undefined,
		};
		const select = vi.fn();
		await withSelector(
			(tui) => ({
				component: new ModelSelectorComponent(tui, undefined, runtime as ModelRuntime, [], select, vi.fn()),
			}),
			async (terminal) => {
				const search = await prependInInput(terminal, "od", "m");
				wheel(terminal, search, "down");
				await terminal.waitForRender();
				findRow(terminal, "→   model-b");
				wheel(terminal, search, "up");
				await terminal.waitForRender();
				findRow(terminal, "→   model-a");
				const continuation = findRow(terminal, "BrightContinuation");
				expect(continuation).toBeGreaterThan(findRow(terminal, "model-b (A"));
				press(terminal, continuation);
				await terminal.waitForRender();
				findRow(terminal, "→   model-b");
				expect(select).not.toHaveBeenCalled();
				release(terminal, continuation);
				expect(select).toHaveBeenCalledExactlyOnceWith(models[1]);
			},
			38,
		);
	});

	it("toggles a scoped model as Enter does without saving or closing the selector", async () => {
		const onChange = vi.fn();
		const onPersist = vi.fn();
		const onCancel = vi.fn();
		const component = new ScopedModelsSelectorComponent(
			{ allModels: [model("model-a"), model("model-b")], enabledModelIds: null },
			{ onChange, onPersist, onCancel },
		);
		await withSelector(
			() => ({ component }),
			async (terminal) => {
				await prependInInput(terminal, "od", "m");
				wheel(terminal, findRow(terminal, "Model Configuration"), "down");
				await terminal.waitForRender();
				findRow(terminal, "→ ✓ model-b");
				const row = findRow(terminal, "model-a");
				press(terminal, row);
				await terminal.waitForRender();
				findRow(terminal, "→ ✓ model-a");
				expect(onChange).not.toHaveBeenCalled();
				release(terminal, row);
				expect(onChange).toHaveBeenCalledExactlyOnceWith(["example/model-b"]);
				expect(onPersist).not.toHaveBeenCalled();
				expect(onCancel).not.toHaveBeenCalled();
			},
		);
	});

	it("scrolls resume over its search input, guards delete mode, and keeps rename input editable by touch", async () => {
		const sessions = [session("a", "Weave Alpha", 2), session("b", "Weave Beta", 1)];
		const select = vi.fn();
		const renameSession = vi.fn(async () => {});
		await withSelector(
			(tui) => ({
				component: new SessionSelectorComponent(
					async () => sessions,
					async () => [],
					select,
					vi.fn(),
					vi.fn(),
					() => tui.requestRender(),
					{ renameSession, keybindings },
				),
			}),
			async (terminal) => {
				const search = await prependInInput(terminal, "eave", "w");
				wheel(terminal, search, "down");
				await terminal.waitForRender();
				findRow(terminal, "› Weave Beta");
				terminal.sendInput("\x1b[100;5u"); // Ctrl+D
				await terminal.waitForRender();
				wheel(terminal, findRow(terminal, "> weave"), "up");
				tap(terminal, findRow(terminal, "Weave Alpha"));
				expect(select).not.toHaveBeenCalled();
				terminal.sendInput("\x1b");
				terminal.sendInput("\x1b[114;5u"); // Ctrl+R
				await terminal.waitForRender();
				const renameRow = findRow(terminal, "Rename Session");
				const beforeRenameWheel = terminal.getViewport()[0];
				wheel(terminal, renameRow, "up");
				await terminal.waitForRender();
				expect(terminal.getViewport()[0]).not.toBe(beforeRenameWheel);
				tap(terminal, findRow(terminal, "> Weave Beta"));
				terminal.sendInput("New ");
				terminal.sendInput("\r");
				await terminal.waitForRender();
				expect(renameSession).toHaveBeenCalledExactlyOnceWith("/tmp/b.jsonl", "New Weave Beta");
				const row = findRow(terminal, "Weave Alpha");
				press(terminal, row);
				await terminal.waitForRender();
				findRow(terminal, "› Weave Alpha");
				expect(select).not.toHaveBeenCalled();
				release(terminal, row);
				expect(select).toHaveBeenCalledExactlyOnceWith("/tmp/a.jsonl");
			},
		);
	});

	it("scrolls tree entries over search and places the caret in the indented label input", async () => {
		const root = treeNode("a", "First message");
		root.children.push({ ...treeNode("b", "Second message", "a"), label: "Name" });
		const select = vi.fn();
		const label = vi.fn();
		const component = new TreeSelectorComponent([root], "b", 30, select, vi.fn(), label, "a");
		await withSelector(
			() => ({ component }),
			async (terminal) => {
				wheel(terminal, findRow(terminal, "Type to search:"), "down");
				await terminal.waitForRender();
				const selected = findRow(terminal, "Second message");
				expect(terminal.getViewport()[selected - 1]).toMatch(/^› /);
				terminal.sendInput("L");
				await terminal.waitForRender();
				const labelRow = findRow(terminal, "> Name");
				const beforeLabelWheel = terminal.getViewport()[0];
				wheel(terminal, labelRow, "up");
				await terminal.waitForRender();
				expect(terminal.getViewport()[0]).not.toBe(beforeLabelWheel);
				tap(terminal, labelRow, 6);
				terminal.sendInput("X");
				terminal.sendInput("\r");
				await terminal.waitForRender();
				expect(label).toHaveBeenCalledExactlyOnceWith("b", "NXame");
				const row = findRow(terminal, "First message");
				press(terminal, row);
				await terminal.waitForRender();
				expect(terminal.getViewport()[row - 1]).toMatch(/^› /);
				expect(select).not.toHaveBeenCalled();
				release(terminal, row);
				expect(select).toHaveBeenCalledExactlyOnceWith("a");
			},
		);
	});

	it("forks from the metadata line of the pressed message even when the list recenters", async () => {
		const select = vi.fn();
		const messages = Array.from({ length: 13 }, (_, index) => ({
			id: `message-${index + 1}`,
			text: `A message ${index + 1}`,
		}));
		const component = new UserMessageSelectorComponent(messages, select, vi.fn(), "message-1");
		await withSelector(
			() => ({ component, focus: component.getMessageList() }),
			async (terminal) => {
				wheel(terminal, findRow(terminal, "Fork from Message"), "down");
				await terminal.waitForRender();
				findRow(terminal, "› A message 2");
				const row = findRow(terminal, "Message 9 of 13");
				press(terminal, row);
				await terminal.waitForRender();
				findRow(terminal, "› A message 9");
				expect(findRow(terminal, "Message 9 of 13")).not.toBe(row);
				expect(select).not.toHaveBeenCalled();
				release(terminal, row);
				expect(select).toHaveBeenCalledExactlyOnceWith("message-9");
			},
		);
	});

	it("swallows wheel over an empty provider filter and selects the tapped auth method", async () => {
		const select = vi.fn();
		const component = new OAuthSelectorComponent(
			"login",
			[
				{ id: "alpha", name: "Acme Alpha", authType: "api_key" },
				{ id: "beta", name: "Acme Beta", authType: "oauth" },
			],
			select,
			vi.fn(),
		);
		await withSelector(
			() => ({ component }),
			async (terminal) => {
				const search = await prependInInput(terminal, "cme", "a");
				wheel(terminal, search, "down");
				await terminal.waitForRender();
				findRow(terminal, "→ Acme Beta");
				terminal.sendInput("zzz");
				await terminal.waitForRender();
				findRow(terminal, "No matching providers");
				wheel(terminal, search, "up");
				await terminal.waitForRender();
				findRow(terminal, "Transcript 50");
				for (let i = 0; i < 3; i++) terminal.sendInput("\x7f");
				await terminal.waitForRender();
				tap(terminal, findRow(terminal, "Acme Beta"));
				expect(select).toHaveBeenCalledExactlyOnceWith("beta", "oauth");
			},
		);
	});

	it("scrolls over project trust details and activates the tapped trust decision", async () => {
		const onSelect = vi.fn();
		const component = new TrustSelectorComponent({
			cwd: "/tmp/project",
			savedDecision: null,
			projectTrusted: true,
			onSelect,
			onCancel: vi.fn(),
		});
		await withSelector(
			() => ({ component }),
			async (terminal) => {
				wheel(terminal, findRow(terminal, "Saved decision:"), "down");
				await terminal.waitForRender();
				findRow(terminal, "→   Trust parent folder");
				tap(terminal, findRow(terminal, "Do not trust"));
				expect(onSelect).toHaveBeenCalledExactlyOnceWith(
					expect.objectContaining({ trusted: false, updates: [expect.objectContaining({ decision: false })] }),
				);
			},
		);
	});

	it("scrolls thinking levels from the search line and still forwards input and row clicks", async () => {
		const select = vi.fn();
		const component = new ThinkingSelectorComponent("off", ["off", "low", "high"], select, vi.fn());
		await withSelector(
			() => ({ component }),
			async (terminal) => {
				const search = await prependInInput(terminal, "ea", "r");
				wheel(terminal, search, "down");
				wheel(terminal, search, "down");
				await terminal.waitForRender();
				findRow(terminal, "→   high");
				tap(terminal, findRow(terminal, "Light reasoning"));
				expect(select).toHaveBeenCalledExactlyOnceWith("low");
			},
		);
	});

	it("handles wheel over the settings search box and outside the settings list", async () => {
		const onAutoCompactChange = vi.fn();
		const onThemeChange = vi.fn();
		const onThemePreview = vi.fn();
		const callbacks: Pick<SettingsCallbacks, "onAutoCompactChange" | "onThemeChange" | "onThemePreview"> = {
			onAutoCompactChange,
			onThemeChange,
			onThemePreview,
		};
		const component = new SettingsSelectorComponent(
			{
				...SETTINGS_DEFAULTS,
				autoCompact: true,
				defaultModel: "not set",
				availableDefaultModels: [],
				showImages: true,
				imageWidthCells: 60,
				autoResizeImages: true,
				blockImages: false,
				httpIdleTimeoutMs: 0,
				cacheWarmingMode: "idle",
				thinkingLevel: "off",
				availableThinkingLevels: [],
				modelThinkingLevels: {},
				currentTheme: "dark",
				terminalTheme: "dark",
				availableThemes: ["dark", "light"],
				mermaidRenderingMode: "streaming",
				showHardwareCursor: false,
				clearOnShrink: false,
				showTerminalProgress: false,
			},
			callbacks as SettingsCallbacks,
		);
		await withSelector(
			() => ({ component, focus: component.getSettingsList() }),
			async (terminal) => {
				const search = findRow(terminal, ">");
				wheel(terminal, search - 1, "up");
				wheel(terminal, search, "down");
				await terminal.waitForRender();
				findRow(terminal, "Transcript 50");
				findRow(terminal, "  Auto-compact");
				tap(terminal, findRow(terminal, "Auto-compact"));
				expect(onAutoCompactChange).toHaveBeenCalledExactlyOnceWith(false);
				// Open Theme submenu, scroll over the frame, and verify keyboard focus remains on SettingsList.
				terminal.sendInput("Theme");
				await terminal.waitForRender();
				terminal.sendInput("\r");
				await terminal.waitForRender();
				findRow(terminal, "→ ✓ dark");
				wheel(terminal, findRow(terminal, "Select a theme"), "down");
				await terminal.waitForRender();
				findRow(terminal, "→   light");
				terminal.sendInput("\x1b[A");
				await terminal.waitForRender();
				findRow(terminal, "→ ✓ dark");
				terminal.sendInput("\r");
				await terminal.waitForRender();
				expect(onThemeChange).toHaveBeenCalledExactlyOnceWith("dark");
			},
		);
	});

	it("routes mouse to each settings step and retains keyboard focus when it closes", async () => {
		const selected = vi.fn();
		const changed = vi.fn();
		const select = new SettingsList(
			[
				{
					id: "steps",
					label: "Open steps",
					currentValue: "",
					submenu: (_value, done) =>
						new SteppedSubmenu(
							[
								{
									key: "first",
									title: "First step",
									description: "The description can wrap before the input",
									options: () => selectItems(["On Alpha", "On Beta"]),
									searchable: true,
								},
								{
									key: "second",
									title: "Second step",
									description: "Next",
									options: () => selectItems(["One", "Two"]),
								},
							],
							selected,
							done,
						),
				},
				{ id: "after", label: "After steps", currentValue: "off", values: ["off", "on"] },
			],
			5,
			getSettingsListTheme(),
			changed,
			vi.fn(),
		);
		await withSelector(
			() => ({ component: select }),
			async (terminal) => {
				terminal.sendInput("\r");
				await terminal.waitForRender();
				await prependInInput(terminal, "n", "o");
				wheel(terminal, findRow(terminal, "First step"), "down");
				await terminal.waitForRender();
				findRow(terminal, "→ On Beta");
				tap(terminal, findRow(terminal, "On Beta"));
				await terminal.waitForRender();
				findRow(terminal, "Second step");
				expect(selected).not.toHaveBeenCalled();
				tap(terminal, findRow(terminal, "Two"));
				expect(selected).toHaveBeenCalledExactlyOnceWith({ first: "On Beta", second: "Two" });
				terminal.sendInput("\x1b[B");
				terminal.sendInput("\r");
				expect(changed).toHaveBeenCalledExactlyOnceWith("after", "on");
			},
		);
	});

	it("scrolls and clicks an MCP menu through its frame, then clicks into the redirect URL input", async () => {
		let menu: Promise<string | undefined>;
		let view: McpManagerView;
		await withSelector(
			(tui) => {
				view = new McpManagerView(tui, theme, keybindings);
				menu = view.menu(() => ({
					title: "MCP servers",
					details: "Connection details that may wrap in the terminal",
					items: selectItems(["First server", "Second server"]),
					confirmLabel: "open",
					cancelLabel: "close",
				}));
				return { component: view };
			},
			async (terminal) => {
				wheel(terminal, findRow(terminal, "MCP servers"), "down");
				await terminal.waitForRender();
				findRow(terminal, "→ Second server");
				tap(terminal, findRow(terminal, "First server"));
				await expect(menu).resolves.toBe("First server");
				const redirect = view.redirectUrl(
					"MCP sign-in",
					"https://example.invalid/login",
					new AbortController().signal,
				);
				await terminal.waitForRender();
				await prependInInput(terminal, "example.invalid/redirect", "https://");
				terminal.sendInput("\r");
				await expect(redirect).resolves.toBe("https://example.invalid/redirect");
			},
		);
	});

	it("routes llama.cpp menu and Hugging Face result clicks and keeps the search caret editable", async () => {
		let menu: Promise<string | undefined>;
		let search: Promise<string | undefined>;
		await withSelector(
			async (tui) => {
				const mounted = Promise.withResolvers<Component>();
				const custom: ExtensionUIContext["custom"] = async (factory) =>
					new Promise((resolve, reject) => {
						void Promise.resolve(factory(tui, theme, keybindings, resolve)).then(mounted.resolve, reject);
					});
				const context: { ui: Pick<ExtensionUIContext, "custom" | "notify"> } = { ui: { custom, notify: vi.fn() } };
				void showLlamaUi(context as ExtensionCommandContext, async (ui) => {
					menu = ui.select("llama.cpp menu", ["First option", "Second option"]);
					await menu;
					search = ui.searchModels(async () => [
						{ id: "org/first-gguf", downloads: 10 },
						{ id: "org/second-gguf", downloads: 20 },
					]);
					await search;
				});
				return { component: await mounted.promise };
			},
			async (terminal) => {
				wheel(terminal, findRow(terminal, "llama.cpp menu"), "down");
				await terminal.waitForRender();
				findRow(terminal, "→ Second option");
				tap(terminal, findRow(terminal, "First option"));
				await expect(menu).resolves.toBe("First option");
				await terminal.waitForRender();
				const input = await prependInInput(terminal, "rg", "o");
				await vi.waitFor(() => findRow(terminal, "→ org/first-gguf"));
				wheel(terminal, input, "down");
				await terminal.waitForRender();
				findRow(terminal, "→ org/second-gguf");
				tap(terminal, findRow(terminal, "org/first-gguf"));
				await expect(search).resolves.toBe("org/first-gguf");
			},
		);
	});

	it("scrolls over the image and theme selector borders", async () => {
		const image = vi.fn();
		const images = new ShowImagesSelectorComponent(true, image, vi.fn());
		await withSelector(
			() => ({ component: images, focus: images.getSelectList() }),
			async (terminal) => {
				wheel(terminal, findRow(terminal, "Yes") - 1, "down");
				await terminal.waitForRender();
				findRow(terminal, "→ No");
				tap(terminal, findRow(terminal, "Yes"));
				expect(image).toHaveBeenCalledExactlyOnceWith(true);
			},
		);
		const select = vi.fn();
		const themes = new ThemeSelectorComponent("dark", select, vi.fn(), vi.fn());
		await withSelector(
			() => ({ component: themes, focus: themes.getSelectList() }),
			async (terminal) => {
				const before = themes.getSelectList().getSelectedItem()?.value;
				wheel(terminal, findRow(terminal, "──────────"), "down");
				await terminal.waitForRender();
				expect(themes.getSelectList().getSelectedItem()?.value).not.toBe(before);
				tap(terminal, findRow(terminal, "(current)"));
				expect(select).toHaveBeenCalledExactlyOnceWith("dark");
			},
		);
	});
});
