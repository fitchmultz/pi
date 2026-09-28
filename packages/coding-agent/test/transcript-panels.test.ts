import { Container, Text } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { ChatContainer } from "../src/modes/interactive/components/activity.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import * as changelog from "../src/utils/changelog.ts";

beforeAll(() => initTheme("dark"));

function createMode() {
	const chat = new ChatContainer();
	const settings = SettingsManager.inMemory({ collapseChangelog: false });
	const mode = Object.assign(Object.create(InteractiveMode.prototype), {
		chatContainer: chat,
		runtimeHost: { session: { settingsManager: settings, extensionRunner: { getShortcuts: () => new Map() } } },
		keybindings: { getEffectiveConfig: () => ({}) },
		ui: { requestRender() {} },
		changelogMarkdown: "## [99.0.0]\n\nRelease note body",
		version: "99.0.0",
	}) as Pick<
		InteractiveMode,
		"showExtensionError" | "showNewVersionNotification" | "showPackageUpdateNotification"
	> & {
		showStartupNoticesIfNeeded(): void;
		handleChangelogCommand(): void;
		handleHotkeysCommand(): void;
	};
	return { mode, chat, settings };
}

type Fixture = ReturnType<typeof createMode>;
const panels: Array<{ name: string; show(fixture: Fixture): void; content: string[] }> = [
	{
		name: "startup changelog",
		show: ({ mode }) => mode.showStartupNoticesIfNeeded(),
		content: ["What's New", "Release note body"],
	},
	{
		name: "collapsed startup changelog",
		show: ({ mode, settings }) => {
			settings.setCollapseChangelog(true);
			mode.showStartupNoticesIfNeeded();
		},
		content: ["Updated to v99.0.0"],
	},
	{
		name: "extension error with stack",
		show: ({ mode }) => mode.showExtensionError("example.ts", "failure", "Error: failure\n at first\n at second"),
		content: ['Extension "example.ts" error: failure', "at first", "at second"],
	},
	{
		name: "extension error without stack",
		show: ({ mode }) => mode.showExtensionError("example.ts", "failure"),
		content: ['Extension "example.ts" error: failure'],
	},
	{
		name: "version update with note",
		show: ({ mode }) => mode.showNewVersionNotification({ version: "99.0.0", note: "Release note body" }),
		content: ["Update Available", "Release note body", "Changelog:"],
	},
	{
		name: "version update without note",
		show: ({ mode }) => mode.showNewVersionNotification({ version: "99.0.0" }),
		content: ["Update Available", "Changelog:"],
	},
	{
		name: "package update",
		show: ({ mode }) => mode.showPackageUpdateNotification(["first-package", "second-package"]),
		content: ["Package Updates Available", "first-package", "second-package"],
	},
	{
		name: "changelog command",
		show: ({ mode }) => {
			const spy = vi
				.spyOn(changelog, "parseChangelog")
				.mockReturnValue([{ major: 99, minor: 0, patch: 0, content: "## [99.0.0]\n\nRelease note body" }]);
			try {
				mode.handleChangelogCommand();
			} finally {
				spy.mockRestore();
			}
		},
		content: ["What's New", "Release note body"],
	},
	{
		name: "hotkeys command",
		show: ({ mode }) => mode.handleHotkeysCommand(),
		content: ["Keyboard Shortcuts", "Navigation", "Editing", "Other"],
	},
];

describe.each([false, true])("atomic native transcript panels (compact=%s)", (compact) => {
	test.each(panels)("$name preserves its rows when reversing transcript blocks", (panel) => {
		const fixture = createMode();
		const { chat } = fixture;
		chat.setCompactView(compact);
		const older = new Text("OLDER MESSAGE", 0, 0);
		const newer = new Text("NEWER MESSAGE", 0, 0);
		chat.addChild(older);
		panel.show(fixture);
		const chronological = chat.render(80);
		const panelLines = chronological.slice(older.render(80).length);
		const plain = panelLines.map(stripAnsi).join("\n");
		let previous = -1;
		for (const content of panel.content) {
			const index = plain.indexOf(content);
			expect(index).toBeGreaterThan(previous);
			previous = index;
		}
		chat.addChild(newer);
		const backingChildren = [...chat.children];
		chat.setTranscriptOrder("newest-first");
		expect(chat.render(80)).toEqual([...newer.render(80), ...panelLines, ...older.render(80)]);
		expect(chat.children).toEqual(backingChildren);
		chat.setTranscriptOrder("oldest-first");
		expect(chat.render(80)).toEqual([...chronological, ...newer.render(80)]);
		// A plain Container adds no rows, padding, or styling to its children.
		const flattened = new Container();
		flattened.children = chat.children.flatMap((child) =>
			child.constructor === Container ? (child as Container).children : [child],
		);
		expect(chat.render(80)).toEqual(flattened.render(80));
	});
});
