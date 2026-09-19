import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBuiltinModelDataGeneratedAt } from "@earendil-works/pi-ai/providers/all";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import { main } from "../src/main.ts";

// Control terminal interaction and deadline/HTTP completion, not model behavior.
// main, trust resolution, resource loading, services, file-backed stores,
// provider composition and initial selection are real.
const ui = vi.hoisted(() => ({
	select: vi.fn(),
	run: vi.fn<(runtime: AgentSessionRuntime) => Promise<void>>(),
}));
vi.mock("../src/cli/startup-ui.ts", () => ({
	shouldRunFirstTimeSetup: () => false,
	showStartupSelector: ui.select,
}));
vi.mock("../src/modes/index.ts", () => ({
	InteractiveMode: class {
		private runtime: AgentSessionRuntime;
		constructor(runtime: AgentSessionRuntime) {
			this.runtime = runtime;
		}
		run() {
			return ui.run(this.runtime);
		}
	},
}));

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const cached = { ...anthropicProvider().getModels()[0], id: "deadline-cached-only" };
const timeoutReason = () => new DOMException("The operation timed out.", "TimeoutError");

describe("CLI model startup deadline ownership (PR #62)", () => {
	let directory: string;
	let agentDir: string;
	let deadlines: AbortController[];
	let runtime: AgentSessionRuntime | undefined;
	let inputDescriptor: PropertyDescriptor | undefined;
	let outputDescriptor: PropertyDescriptor | undefined;

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "pi-cli-model-deadline-"));
		agentDir = join(directory, "agent");
		mkdirSync(agentDir);
		mkdirSync(join(directory, ".pi", "extensions"), { recursive: true });
		writeFileSync(join(directory, ".pi", "extensions", "noop.ts"), "export default function () {}\n");
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				defaultProvider: "anthropic",
				defaultModel: cached.id,
				theme: "dark",
				enableInstallTelemetry: false,
			}),
		);
		writeFileSync(
			join(agentDir, "models-store.json"),
			JSON.stringify({
				anthropic: { models: [cached], lastModified: (getBuiltinModelDataGeneratedAt() ?? Date.now()) + 60_000 },
			}),
		);
		for (const name of Object.keys(process.env)) {
			if (/KEY|TOKEN|SECRET|^AWS_|^GOOGLE_|^AZURE_|^CLOUDFLARE_|^PI_/.test(name)) vi.stubEnv(name, undefined);
		}
		vi.stubEnv("HOME", directory);
		vi.stubEnv("USERPROFILE", directory);
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		vi.spyOn(process, "cwd").mockReturnValue(directory);
		inputDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
		outputDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
		Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
		deadlines = [];
		vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
			expect(ms).toBe(15_000);
			const controller = new AbortController();
			deadlines.push(controller);
			return controller.signal;
		});
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network request"));
		ui.select.mockReset();
		ui.select.mockResolvedValue("Trust (this session only)");
		ui.run.mockReset();
		ui.run.mockImplementation(async (created) => {
			runtime = created;
		});
	});

	afterEach(async () => {
		if (runtime) {
			await runtime.services.modelRuntime.flushForCheckpoint();
			await runtime.dispose();
			runtime = undefined;
		}
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		if (inputDescriptor) Object.defineProperty(process.stdin, "isTTY", inputDescriptor);
		else Reflect.deleteProperty(process.stdin, "isTTY");
		if (outputDescriptor) Object.defineProperty(process.stdout, "isTTY", outputDescriptor);
		else Reflect.deleteProperty(process.stdout, "isTTY");
		rmSync(directory, { recursive: true, force: true });
	});

	it("still bounds ambient network checks in the post-extension offline barrier", async () => {
		const started = deferred();
		const requestSignals: AbortSignal[] = [];
		ui.select.mockImplementation(async () => {
			deadlines[0].abort(timeoutReason());
			return "Trust (this session only)";
		});
		vi.mocked(globalThis.fetch).mockImplementation(async (url, options) => {
			expect(url).toBe("https://metadata.example.test/check");
			const signal = options?.signal;
			if (!signal) throw new Error("Missing metadata deadline");
			signal.throwIfAborted();
			requestSignals.push(signal);
			started.resolve();
			return new Promise<Response>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		});
		const startup = main(
			["--offline", "--no-session", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"],
			{
				extensionFactories: [
					(pi) => {
						pi.registerProvider("anthropic", {
							ambientAuth: {
								async check({ signal }) {
									await fetch("https://metadata.example.test/check", { signal });
									return { type: "oauth", source: "synthetic account" };
								},
								resolve: async () => undefined,
							},
						});
					},
				],
			},
		);
		try {
			expect(await Promise.race([started.promise.then(() => "started"), startup.then(() => "skipped")])).toBe(
				"started",
			);
			expect(deadlines).toHaveLength(2);
			expect(deadlines[1].signal.aborted).toBe(false);
			deadlines[1].abort(timeoutReason());
			await startup;
			// PR #66: one observation supplies both availability and auth classification.
			expect(requestSignals).toHaveLength(1);
			expect(requestSignals.every((signal) => signal.aborted)).toBe(true);
			expect(runtime?.session.model).toBeUndefined();
			expect(runtime?.services.modelRuntime.hasConfiguredAuth("anthropic")).toBe(false);
			await runtime?.services.modelRuntime.flushForCheckpoint();
			expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		} finally {
			for (const deadline of deadlines) deadline.abort();
			await startup;
		}
	});

	it.each(["control", "trust prompt", "extension factory"])(
		"selects the saved cached model after time spent in %s",
		async (delay) => {
			if (delay === "trust prompt")
				ui.select.mockImplementation(async () => {
					expect(deadlines).toHaveLength(1);
					deadlines[0].abort(timeoutReason());
					return "Trust (this session only)";
				});
			const check = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
				signal.throwIfAborted();
				return { type: "oauth" as const, source: "synthetic account" };
			});
			const factory: ExtensionFactory = async (pi) => {
				if (delay === "extension factory") {
					await Promise.resolve();
					deadlines[0].abort(timeoutReason());
				}
				pi.registerProvider("anthropic", { ambientAuth: { check, resolve: async () => undefined } });
			};
			await main(
				["--offline", "--no-session", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"],
				{
					extensionFactories: [factory],
				},
			);
			expect(ui.select).toHaveBeenCalledWith(
				expect.anything(),
				expect.stringContaining("Trust project folder?"),
				expect.anything(),
			);
			console.log("CLI deadline", { delay, checks: check.mock.calls.length, selected: runtime?.session.model?.id });
			expect(runtime?.session.model?.id).toBe(cached.id);
			expect(runtime?.services.modelRuntime.hasConfiguredAuth("anthropic")).toBe(true);
			expect(runtime?.services.modelRuntime.isUsingSubscription("anthropic")).toBe(true);
			expect(runtime?.services.modelRuntime.getAvailableSnapshot()).toContainEqual(cached);
			expect(check).toHaveBeenCalledTimes(1);
			expect(globalThis.fetch).not.toHaveBeenCalled();
		},
	);
});
