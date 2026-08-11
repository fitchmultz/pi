import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "../src/modes/interactive/components/settings-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("SettingsSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	describe("theme override", () => {
		function focusThemeSetting(currentTheme: string, themeOverride?: string) {
			const onThemePreview = vi.fn();
			const selector = new SettingsSelectorComponent(
				{
					currentTheme,
					themeOverride,
					terminalTheme: "dark",
					availableThemes: ["dark", "light", "solarized", "dayowl", "nightowl"],
					fullscreenScrollbar: "auto",
					warnings: {},
					availableThinkingLevels: [],
				} as unknown as SettingsConfig,
				{ onThemePreview } as unknown as SettingsCallbacks,
			);
			const settingsList = selector.getSettingsList();

			for (const character of "Theme") settingsList.handleInput(character);
			return { settingsList, onThemePreview };
		}

		function openThemeSettings(currentTheme: string, themeOverride?: string) {
			const result = focusThemeSetting(currentTheme, themeOverride);
			result.settingsList.handleInput("\r");
			return result;
		}

		it("describes the active theme override", () => {
			const { settingsList } = focusThemeSetting("light/dark", "dayowl/nightowl");

			expect(stripAnsi(settingsList.render(120).join("\n"))).toContain(
				"Color theme for the interface. Active override: dayowl/nightowl",
			);
		});

		it("previews the saved theme when it differs from the override", () => {
			const { onThemePreview } = openThemeSettings("light", "dayowl");

			expect(onThemePreview).toHaveBeenCalledOnce();
			expect(onThemePreview).toHaveBeenCalledWith("light");
		});

		it("does not reapply the saved theme without an override", () => {
			const { onThemePreview } = openThemeSettings("light");

			expect(onThemePreview).not.toHaveBeenCalled();
		});

		it("previews the saved automatic setting when its active side matches the override", () => {
			const { onThemePreview } = openThemeSettings("light/dark", "dayowl/dark");

			expect(onThemePreview).toHaveBeenCalledOnce();
			expect(onThemePreview).toHaveBeenCalledWith("light/dark");
		});

		it.each([
			["light", 0],
			["dark", 1],
		] as const)("previews the saved %s theme when entering its nested picker", (appearance, downPresses) => {
			const { settingsList, onThemePreview } = openThemeSettings("light/dark", "dayowl/nightowl");

			onThemePreview.mockClear();
			for (let i = 0; i < downPresses; i++) settingsList.handleInput("\x1b[B");
			settingsList.handleInput("\r");

			expect(onThemePreview).toHaveBeenCalledOnce();
			expect(onThemePreview).toHaveBeenCalledWith(appearance);
		});

		it.each([
			["light", 0, "dayowl"],
			["dark", 1, "nightowl"],
		] as const)("marks the %s side of a paired override", (_appearance, downPresses, overrideName) => {
			const { settingsList } = openThemeSettings("light/dark", "dayowl/nightowl");

			for (let i = 0; i < downPresses; i++) settingsList.handleInput("\x1b[B");
			settingsList.handleInput("\r");

			expect(stripAnsi(settingsList.render(120).join("\n"))).toMatch(
				new RegExp(`${overrideName}\\s+Override from --use-theme`),
			);
		});

		it("restores the automatic parent preview after canceling a nested picker", () => {
			const { settingsList, onThemePreview } = openThemeSettings("light", "dayowl/nightowl");

			settingsList.handleInput("\x1b[A");
			settingsList.handleInput("\x1b[A");
			settingsList.handleInput("\r");
			settingsList.handleInput("\r");
			onThemePreview.mockClear();
			settingsList.handleInput("\x1b");

			expect(onThemePreview.mock.calls.flat()).toEqual(["light/light"]);
		});

		it("restores a paired override after canceling the automatic preview", () => {
			const { settingsList, onThemePreview } = openThemeSettings("light/dark", "dayowl/nightowl");

			onThemePreview.mockClear();
			settingsList.handleInput("\x1b");

			expect(onThemePreview.mock.calls.flat()).toEqual(["dayowl/nightowl"]);
		});

		it("marks a single-theme override", () => {
			const { settingsList } = openThemeSettings("light", "dayowl");

			expect(stripAnsi(settingsList.render(120).join("\n"))).toMatch(/dayowl\s+Override from --use-theme/);
		});

		it("restores a single-theme override after canceling a direct preview", () => {
			const { settingsList, onThemePreview } = openThemeSettings("light", "dayowl");

			onThemePreview.mockClear();

			settingsList.handleInput("\x1b[B");
			settingsList.handleInput("\x1b");

			expect(onThemePreview.mock.calls.flat()).toEqual(["solarized", "dayowl"]);
		});
	});

	it("cycles through fullscreen settings", () => {
		const onExitOutputChange = vi.fn();
		const onScrollbarChange = vi.fn();
		const config = {
			fullscreenExitOutput: "transcript",
			fullscreenScrollbar: "auto",
			warnings: {},
			availableThinkingLevels: [],
			availableThemes: [],
		} as unknown as SettingsConfig;
		const callbacks = {
			onFullscreenExitOutputChange: onExitOutputChange,
			onFullscreenScrollbarChange: onScrollbarChange,
		} as unknown as SettingsCallbacks;

		const cycle = (label: string, count: number) => {
			const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();
			for (const character of label) list.handleInput(character);
			for (let i = 0; i < count; i++) list.handleInput("\r");
		};

		cycle("Fullscreen exit output", 2);
		expect(onExitOutputChange.mock.calls.flat()).toEqual(["resume-hint", "transcript"]);
		cycle("Fullscreen scrollbar", 3);
		expect(onScrollbarChange.mock.calls.flat()).toEqual(["always", "hidden", "auto"]);
	});
});
