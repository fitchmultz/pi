import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import permissionGate from "../../examples/extensions/permission-gate.ts";
import planMode from "../../examples/extensions/plan-mode/index.ts";
import sandbox from "../../examples/extensions/sandbox/index.ts";
import ssh from "../../examples/extensions/ssh.ts";
import backgroundCommand from "../../src/extensions/background-command/index.ts";
import { backgroundCommandDirectory, listBackgroundCommands } from "../../src/extensions/background-command/jobs.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { createHarness, getMessageText, getToolResult, type Harness } from "./harness.ts";

describe("background shell permission guards", () => {
	let h: Harness | undefined;
	beforeAll(() => initTheme("dark", false));
	afterEach(async () => {
		await h?.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		h?.cleanup();
		vi.restoreAllMocks();
	});
	it.each([
		{ name: "permission", factory: permissionGate, flag: undefined },
		{ name: "plan", factory: planMode, flag: ["plan", true] as const },
		{ name: "sandbox", factory: sandbox, flag: undefined },
		{ name: "ssh", factory: ssh, flag: ["ssh", "unused-host:/tmp"] as const },
	])("$name blocks background starts without disabling status", async ({ factory, flag }) => {
		vi.spyOn(SandboxManager, "initialize").mockResolvedValue(undefined);
		vi.spyOn(SandboxManager, "reset").mockResolvedValue(undefined);
		h = await createHarness({ extensionFactories: [backgroundCommand, factory] });
		if (flag) h.session.resourceLoader.getExtensions().runtime.flagValues.set(flag[0], flag[1]);
		await h.session.bindExtensions({ mode: "print" });
		h.session.setActiveToolsByName([...h.session.getActiveToolNames(), "background_command"]);
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("background_command", { action: "start", command: "sudo true" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Blocked"),
		]);
		await h.session.prompt("Try a guarded command");
		expect(getToolResult(h, "background_command").isError).toBe(true);
		expect(getMessageText(getToolResult(h, "background_command"))).toMatch(/blocked|disabled|does not support/i);
		expect(listBackgroundCommands(backgroundCommandDirectory(h.sessionManager))).toEqual([]);
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("background_command", { action: "status" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Inspected"),
		]);
		await h.session.prompt("Inspect jobs");
		expect(getToolResult(h, "background_command").isError).toBe(false);
		expect(JSON.parse(getMessageText(getToolResult(h, "background_command")))).toEqual({
			jobs: [],
			total: 0,
			nextOffset: null,
		});
	});
	it.skipIf(process.platform !== "darwin" && process.platform !== "linux").each(["abort", "timeout"])(
		"sandbox %s stops waiting shells before they can continue",
		async (kind) => {
			vi.spyOn(SandboxManager, "initialize").mockResolvedValue(undefined);
			vi.spyOn(SandboxManager, "reset").mockResolvedValue(undefined);
			// Exercise the example's real process backend without testing OS sandbox policy.
			vi.spyOn(SandboxManager, "wrapWithSandbox").mockImplementation(async (command) => command);
			const harness = await createHarness({ extensionFactories: [sandbox] });
			h = harness;
			await harness.session.bindExtensions({ mode: "print" });
			const childPids = join(harness.tempDir, "children.pid");
			const ready = join(harness.tempDir, "ready");
			const continued = join(harness.tempDir, "continued");
			const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
			const children = 64;
			const nested = [
				`printf '%s\\n' "$$" >> ${quote(childPids)}`,
				`i=0; while [ "$i" -lt ${children} ]; do sleep 600 & pid=$!; printf '%s\\n' "$pid" >> ${quote(childPids)}; i=$((i + 1)); done`,
				`printf 'ready' > ${quote(ready)}`,
				`wait "$pid"`,
				`printf 'nested\\n' >> ${quote(continued)}`,
			].join("; ");
			const command = `printf 'before stop\\n'; printf '%s\\n' "$$" > ${quote(childPids)}; "$BASH" -c ${quote(nested)}; printf 'outer\\n' >> ${quote(continued)}`;
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("bash", { command, ...(kind === "timeout" ? { timeout: 2 } : {}) }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("Stopped"),
			]);
			const running = harness.session.prompt("Run a sandboxed command");
			try {
				await expect.poll(() => existsSync(ready), { timeout: 5000 }).toBe(true);
				const pids = readFileSync(childPids, "utf8").trim().split("\n").map(Number);
				expect(pids).toHaveLength(children + 2);
				expect(pids.every((pid) => Number.isSafeInteger(pid) && pid > 1)).toBe(true);
				if (kind === "abort") await harness.session.abort();
				await running;
				const result = getToolResult(harness, "bash");
				expect(result.isError).toBe(true);
				expect(getMessageText(result)).toContain("before stop");
				expect(getMessageText(result)).toContain(kind === "abort" ? "Command aborted" : "Command timed out");
				await expect
					.poll(
						() =>
							pids.every((pid) => {
								try {
									process.kill(pid, 0);
									return false;
								} catch (error) {
									if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
									return true;
								}
							}),
						{ timeout: 5000 },
					)
					.toBe(true);
				expect(existsSync(continued)).toBe(false);
			} finally {
				await harness.session.abort();
				await running;
				if (existsSync(childPids)) {
					for (const pid of readFileSync(childPids, "utf8").trim().split("\n").map(Number)) {
						if (!Number.isSafeInteger(pid) || pid <= 1) continue;
						try {
							process.kill(pid, "SIGKILL");
						} catch {
							// Preserve any failed assertion while cleaning up the remaining owned PIDs.
						}
					}
				}
			}
		},
	);
});
