import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { AutocompleteProvider, Container } from "@earendil-works/pi-tui";
import { onTestFinished } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { CustomEditor } from "../../src/modes/interactive/components/custom-editor.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

export type TestInteractiveViewState = {
	isInitialized: boolean;
	defaultEditor: CustomEditor;
	autocompleteProvider: AutocompleteProvider | undefined;
	chatContainer: Container;
	pendingMessagesContainer: Container;
	editorContainer: Container;
	setupKeyHandlers(): void;
	setupEditorSubmitHandler(): void;
	bindCurrentSessionExtensions(): Promise<void>;
	subscribeToAgent(): void;
	setToolsExpanded(expanded: boolean): void;
	showSettingsSelector(): void;
};

export async function createTestInteractiveView(harness: Harness, options: { width?: number; height?: number } = {}) {
	const width = options.width ?? 80;
	const height = options.height ?? 40;
	initTheme("dark");
	let rebind = async () => {};
	const terminal = new VirtualTerminal(width, height);
	const mode = new InteractiveMode(
		{
			session: harness.session,
			setBeforeSessionInvalidate() {},
			setRebindSession(callback: () => Promise<void>) {
				rebind = callback;
			},
		} as unknown as AgentSessionRuntime,
		{ terminal },
	);
	const view = mode as unknown as TestInteractiveViewState;
	view.isInitialized = true;
	view.setupKeyHandlers();
	view.setupEditorSubmitHandler();
	await view.bindCurrentSessionExtensions();
	view.subscribeToAgent();
	onTestFinished(() => mode.stop("resume-hint"));
	const submit = async (text: string) => {
		await view.defaultEditor.onSubmit?.(text);
	};
	const text = () => stripAnsi(view.chatContainer.render(width).join("\n"));
	return {
		view,
		terminal,
		rebind: () => rebind(),
		submit,
		text,
	};
}

export interface ExportedToolCard {
	call?: string[];
	collapsed?: string[];
	expanded?: string[];
}

/** The text rows of an exported HTML card part, without markup. */
function cardRows(html: string | undefined): string[] | undefined {
	return html
		?.split("</div>")
		.filter((row) => row !== "")
		.map((row) =>
			row
				.replace(/<[^>]+>/g, "")
				.replace(/&nbsp;/g, "")
				.trimEnd(),
		);
}

/** Saves the messages in a session with the extensions, exports it, and returns what the page holds per call id. */
export async function exportSessionToolCards(
	extensionFactories: NonNullable<HarnessOptions["extensionFactories"]>,
	messages: Message[],
): Promise<Record<string, ExportedToolCard>> {
	const dir = mkdtempSync(join(tmpdir(), "pi-export-cards-"));
	const sessionManager = SessionManager.create(dir, join(dir, "sessions"));
	const harness = await createHarness({ extensionFactories, sessionManager });
	onTestFinished(async () => {
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		harness.cleanup();
		rmSync(dir, { recursive: true, force: true });
	});
	sessionManager.appendMessage({ role: "user", content: "Go.", timestamp: 1 });
	for (const message of messages) sessionManager.appendMessage(message);

	const html = readFileSync(await harness.session.exportToHtml(join(dir, "export.html")), "utf8");
	const data = /<script id="session-data" type="application\/json">([^<]*)<\/script>/.exec(html)?.[1] ?? "";
	const rendered: Record<string, { callHtml?: string; resultHtmlCollapsed?: string; resultHtmlExpanded?: string }> =
		JSON.parse(Buffer.from(data, "base64").toString("utf8")).renderedTools ?? {};
	return Object.fromEntries(
		Object.entries(rendered).map(([id, card]) => [
			id,
			{
				call: cardRows(card.callHtml),
				collapsed: cardRows(card.resultHtmlCollapsed),
				expanded: cardRows(card.resultHtmlExpanded),
			},
		]),
	);
}
