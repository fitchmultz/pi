import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Args } from "../src/cli/args.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createSessionManager } from "../src/main.ts";
import { assistantMsg, userMsg } from "./utilities.ts";

describe("--session and --fork ID resolution", () => {
	let tempRoot: string;
	let currentProject: string;
	let otherProject: string;
	const paths = new Map<string, string>();

	function writeSession(cwd: string, id: string, activityTime: number): string {
		const session = SessionManager.create(cwd, undefined, { id });
		session.appendMessage({ ...userMsg(id), timestamp: activityTime });
		session.appendMessage({ ...assistantMsg(id), timestamp: activityTime });
		return session.getSessionFile()!;
	}

	function args(overrides: Partial<Args>): Args {
		return { messages: [], fileArgs: [], unknownFlags: new Map(), diagnostics: [], ...overrides };
	}

	async function forkSource(arg: string): Promise<string | undefined> {
		const forked = await createSessionManager(
			args({ fork: arg }),
			currentProject,
			undefined,
			SettingsManager.inMemory(),
		);
		return forked.getHeader()?.parentSession;
	}

	beforeEach(() => {
		tempRoot = realpathSync(mkdtempSync(join(tmpdir(), "pi-session-arg-")));
		currentProject = join(tempRoot, "current");
		otherProject = join(tempRoot, "other");
		mkdirSync(currentProject);
		mkdirSync(otherProject);
		vi.stubEnv(ENV_AGENT_DIR, join(tempRoot, "agent"));

		// File name and modification time both put lp-old first; only activity time favors lp-new.
		const newest = writeSession(currentProject, "lp-new", 3_000);
		const imported = join(dirname(newest), "0-imported.jsonl");
		renameSync(newest, imported);
		paths.set("lp-new", imported);
		paths.set("lp-old", writeSession(currentProject, "lp-old", 1_000));
		paths.set("lp-foreign", writeSession(otherProject, "lp-foreign", 9_000));
		paths.set("gx", writeSession(otherProject, "gx", 1_000));
		paths.set("gx-later", writeSession(otherProject, "gx-later", 5_000));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		paths.clear();
		rmSync(tempRoot, { recursive: true, force: true });
	});

	it("opens the most recently active current-project match before any other project", async () => {
		const opened = await createSessionManager(
			args({ session: "lp" }),
			currentProject,
			undefined,
			SettingsManager.inMemory(),
		);

		expect(opened.getSessionFile()).toBe(paths.get("lp-new"));
	});

	it.each([
		{ arg: "lp-o", source: "lp-old" },
		{ arg: "lp-for", source: "lp-foreign" },
		{ arg: "gx", source: "gx" },
		{ arg: "g", source: "gx-later" },
	])("forks $arg from $source", async ({ arg, source }) => {
		expect(await forkSource(arg)).toBe(paths.get(source));
	});

	it("reports a missing ID", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(process, "exit").mockImplementation((code) => {
			throw new Error(`exit:${code}`);
		});

		await expect(forkSource("no-such-session")).rejects.toThrow("exit:1");
		expect(error).toHaveBeenCalledWith(expect.stringContaining("No session found matching 'no-such-session'"));
	});
});
