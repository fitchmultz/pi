import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { SettingsManager } from "../src/core/settings-manager.ts";
import { initTheme, type TerminalTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { InteractiveThemeController } from "../src/modes/interactive/theme/theme-controller.ts";

function createUi(): {
	ui: TUI;
	queryTerminalBackgroundColor: ReturnType<typeof vi.fn>;
	queryTerminalColorScheme: ReturnType<typeof vi.fn>;
	setTerminalColorSchemeNotifications: ReturnType<typeof vi.fn>;
	emitTerminalColorScheme: (terminalTheme: TerminalTheme) => void;
} {
	const queryTerminalBackgroundColor = vi.fn();
	const queryTerminalColorScheme = vi.fn();
	const setTerminalColorSchemeNotifications = vi.fn();
	let terminalColorSchemeListener: ((terminalTheme: TerminalTheme) => void) | undefined;
	const ui = {
		invalidate: vi.fn(),
		requestRender: vi.fn(),
		setTerminalColorSchemeNotifications,
		onTerminalColorSchemeChange: vi.fn((listener: (terminalTheme: TerminalTheme) => void) => {
			terminalColorSchemeListener = listener;
			return vi.fn();
		}),
		queryTerminalBackgroundColor,
		queryTerminalColorScheme,
	} as unknown as TUI;
	return {
		ui,
		queryTerminalBackgroundColor,
		queryTerminalColorScheme,
		setTerminalColorSchemeNotifications,
		emitTerminalColorScheme: (terminalTheme) => terminalColorSchemeListener?.(terminalTheme),
	};
}

function createSettingsManager(themeSetting: string | undefined): {
	settingsManager: SettingsManager;
	setTheme: ReturnType<typeof vi.fn>;
	flush: ReturnType<typeof vi.fn>;
} {
	const setTheme = vi.fn();
	const flush = vi.fn(async () => {});
	const settingsManager = {
		getThemeSetting: vi.fn(() => themeSetting),
		setTheme,
		flush,
	} as unknown as SettingsManager;
	return { settingsManager, setTheme, flush };
}

let tempDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "pi-theme-controller-"));
	vi.stubEnv(ENV_AGENT_DIR, tempDir);
});

afterEach(() => {
	initTheme("dark");
	vi.unstubAllEnvs();
	rmSync(tempDir, { recursive: true, force: true });
});

describe("InteractiveThemeController", () => {
	it("starts with the paired override matching the terminal environment", () => {
		vi.stubEnv("COLORFGBG", "15;0");
		const { ui } = createUi();
		const { settingsManager } = createSettingsManager("dark/light");
		const controller = new InteractiveThemeController(ui, settingsManager, {
			showError: vi.fn(),
			onChanged: vi.fn(),
			themeOverride: "light/dark",
		});

		expect(controller.getTerminalTheme()).toBe("dark");
		expect(theme.name).toBe("dark");
	});

	it("keeps the paired override when settings are reloaded", async () => {
		const { ui, queryTerminalColorScheme, setTerminalColorSchemeNotifications } = createUi();
		queryTerminalColorScheme.mockResolvedValue("light");
		const { settingsManager, setTheme: setPersistedTheme, flush } = createSettingsManager("dark/light");
		const controller = new InteractiveThemeController(ui, settingsManager, {
			showError: vi.fn(),
			onChanged: vi.fn(),
			themeOverride: "light/dark",
		});

		await controller.applyFromSettings();
		expect(theme.name).toBe("light");

		await controller.applyFromSettings();
		expect(theme.name).toBe("light");
		expect(queryTerminalColorScheme).toHaveBeenCalledTimes(2);
		expect(setTerminalColorSchemeNotifications).toHaveBeenCalledWith(true);
		expect(setPersistedTheme).not.toHaveBeenCalled();
		expect(flush).not.toHaveBeenCalled();
	});

	it("switches the paired override when terminal appearance changes", async () => {
		const { ui, queryTerminalColorScheme, emitTerminalColorScheme } = createUi();
		queryTerminalColorScheme.mockResolvedValue("light");
		const { settingsManager } = createSettingsManager("dark/light");
		const controller = new InteractiveThemeController(ui, settingsManager, {
			showError: vi.fn(),
			onChanged: vi.fn(),
			themeOverride: "light/dark",
		});

		await controller.applyFromSettings();
		expect(theme.name).toBe("light");

		emitTerminalColorScheme("dark");
		expect(theme.name).toBe("dark");
	});

	it("reports an unavailable single-theme override", async () => {
		const { ui } = createUi();
		const { settingsManager } = createSettingsManager("light/dark");
		const showError = vi.fn();
		const controller = new InteractiveThemeController(ui, settingsManager, {
			showError,
			onChanged: vi.fn(),
			themeOverride: "missing",
		});

		await controller.applyFromSettings();

		expect(theme.name).toBe("dark");
		expect(showError).toHaveBeenCalledOnce();
		expect(showError.mock.calls[0][0]).toContain('Failed to load theme "missing"');
		expect(showError.mock.calls[0][0]).toContain("Fell back to dark theme.");
	});

	it("validates only the active side of a paired override", async () => {
		const { ui, queryTerminalColorScheme } = createUi();
		queryTerminalColorScheme.mockResolvedValueOnce("light").mockResolvedValueOnce("dark");
		const { settingsManager } = createSettingsManager("dark/light");
		const showError = vi.fn();
		const controller = new InteractiveThemeController(ui, settingsManager, {
			showError,
			onChanged: vi.fn(),
			themeOverride: "missing/light",
		});

		await controller.applyFromSettings();
		expect(theme.name).toBe("dark");
		expect(showError).toHaveBeenCalledOnce();

		await controller.applyFromSettings();
		expect(theme.name).toBe("light");
		expect(showError).toHaveBeenCalledOnce();
	});

	it("prefers a single-theme override over settings", async () => {
		const { ui, queryTerminalBackgroundColor } = createUi();
		const { settingsManager, setTheme: setPersistedTheme, flush } = createSettingsManager("light/dark");
		const controller = new InteractiveThemeController(ui, settingsManager, {
			showError: vi.fn(),
			onChanged: vi.fn(),
			themeOverride: "light",
		});

		expect(theme.name).toBe("light");
		await controller.applyFromSettings();

		expect(theme.name).toBe("light");
		expect(queryTerminalBackgroundColor).not.toHaveBeenCalled();
		expect(setPersistedTheme).not.toHaveBeenCalled();
		expect(flush).not.toHaveBeenCalled();
	});
});
