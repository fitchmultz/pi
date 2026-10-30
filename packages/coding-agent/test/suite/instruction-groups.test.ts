import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	collapseSystemMessages,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	getCurrentSystemMessage,
	getCurrentSystemPrompt,
	getCurrentTools,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { openWorkingSession } from "../../src/core/working-session.ts";
import {
	createAgentSession,
	createCodemodeExtension,
	DefaultResourceLoader,
	type InstructionGroupCollector,
	instructionGroupsExtension,
	SettingsManager,
} from "../../src/index.ts";
import { createHarness, getMessageText, getToolResult, type Harness } from "./harness.ts";

const full = "Full browser safety instructions: inspect before acting. Preserve all owner guidance.";
const later = "Full later instructions";
function owner(
	pi: ExtensionAPI,
	browseExposure: "direct" | "codemode" = "direct",
	instructions: () => string = () => full,
) {
	let managed = () => false;
	pi.events.on("pi:instruction-groups", (data) => {
		const collector = data as InstructionGroupCollector;
		collector.register({
			name: "browser",
			description: "Browser actions",
			tools: ["browse", "optional", "hidden"],
			instructions,
		});
		managed = collector.isManaged;
	});
	for (const name of ["browse", "optional", "hidden"])
		pi.registerTool({
			name,
			label: name,
			description: name,
			parameters: Type.Object({}),
			defaultActive: name === "browse",
			exposure: name === "hidden" ? "hidden" : name === "browse" ? browseExposure : "direct",
			execute: async () => ({ content: [{ type: "text", text: "acted" }], details: undefined }),
		});
	pi.registerTool({
		name: "plain",
		label: "plain",
		description: "Unrelated action",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "plain ran" }], details: undefined }),
	});
	pi.registerTool({
		name: "nested",
		label: "nested",
		description: "Nested call",
		parameters: Type.Object({}),
		exposure: "model-only",
		execute: async (_id, _args, _signal, _update, ctx) => (await ctx.executeTool("browse", {})).result,
	});
	pi.on("before_agent_start", (event) => {
		if (!managed()) event.systemPromptOptions.appendSystemPrompt += full;
	});
}
const discover = (enable = ["browser"]) =>
	fauxAssistantMessage([fauxToolCall("discover_tools", { enable })], { stopReason: "toolUse" });
const script = (code: string) => fauxAssistantMessage([fauxToolCall("codemode", { code })], { stopReason: "toolUse" });
const discoverVia = (path: "direct" | "codemode", enable = ["browser"]) =>
	path === "direct" ? discover(enable) : script(`return await tools.discover_tools(${JSON.stringify({ enable })});`);
const done = () => fauxAssistantMessage("done");

// These exercise the real request, nested-call, branch, and compaction boundaries with no provider traffic.
describe("on-demand instruction groups", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});
	async function setup(options: Parameters<typeof createHarness>[0] = {}) {
		const harness = await createHarness({
			initialActiveToolNames: [],
			extensionFactories: [instructionGroupsExtension, owner],
			...options,
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		return harness;
	}

	const selectedOwners = [
		instructionGroupsExtension,
		owner,
		(pi: ExtensionAPI) => {
			pi.registerTool({
				name: "deselected",
				label: "deselected",
				description: "Separately deselected grouped tool",
				parameters: Type.Object({}),
				execute: async () => ({ content: [], details: undefined }),
			});
			pi.events.on("pi:instruction-groups", (data) =>
				(data as InstructionGroupCollector).register({
					name: "other",
					description: "Other",
					tools: ["deselected"],
					instructions: () => later,
				}),
			);
		},
	];
	async function suppressed() {
		const original = await setup({ initialActiveToolNames: undefined, extensionFactories: selectedOwners });
		// Restore activates extension tools the branch never declared, so declare "deselected" before
		// removing it. "browse" stays undeclared and is deferred as before.
		const initial = original.session.getActiveToolNames();
		original.session.setActiveToolsByName(initial.filter((name) => name !== "discover_tools" && name !== "browse"));
		original.setResponses([done(), done()]);
		await original.session.prompt("declare the deselected tool");
		original.session.setActiveToolsByName(initial.filter((name) => name !== "deselected"));
		await original.session.prompt("unrelated work");
		expect(original.sessionManager.getBranch().findLast((entry) => entry.type === "custom")).toMatchObject({
			data: { enabled: [], inactive: ["browse"] },
		});
		return original;
	}
	function savedBranch(original: Harness) {
		return SessionManager.inMemory(original.tempDir, undefined, [
			original.sessionManager.getHeader()!,
			...original.sessionManager.getBranch(),
		]);
	}

	// fork bug: deferred grouped tools lost on unmanaged resume.
	it.each([
		{
			mode: "excluded discovery",
			excludedToolNames: ["discover_tools"],
			factories: selectedOwners,
			selection: undefined,
			active: true,
		},
		{
			mode: "absent factory",
			excludedToolNames: [],
			factories: selectedOwners.slice(1),
			selection: undefined,
			active: true,
		},
		{
			mode: "excluded grouped tool",
			excludedToolNames: ["discover_tools", "browse"],
			factories: selectedOwners,
			selection: undefined,
			active: false,
		},
		{
			mode: "managed exclusion",
			excludedToolNames: ["browse"],
			factories: selectedOwners,
			selection: undefined,
			active: false,
		},
		{
			mode: "explicit allowlist",
			excludedToolNames: [],
			factories: selectedOwners,
			selection: ["read", "bash"],
			active: false,
		},
		{ mode: "no tools", excludedToolNames: [], factories: selectedOwners, selection: [], active: false },
		{
			mode: "managed allowlist",
			excludedToolNames: [],
			factories: selectedOwners,
			selection: ["read", "discover_tools"],
			active: false,
		},
		{
			mode: "managed selected tools",
			excludedToolNames: [],
			factories: selectedOwners,
			selection: ["read", "discover_tools", "browse", "optional"],
			active: true,
		},
		{
			mode: "explicit deselection",
			excludedToolNames: [],
			factories: selectedOwners,
			selection: ["read", "discover_tools", "browse", "optional"],
			active: false,
		},
	])("restores saved selected tools with $mode without rewriting the prefix", async (testCase) => {
		const original = await suppressed();
		const resumed = await setup({
			initialActiveToolNames: testCase.selection,
			allowedToolNames: testCase.selection,
			sessionManager: savedBranch(original),
			extensionFactories: testCase.factories,
			excludedToolNames: testCase.excludedToolNames,
		});
		if (testCase.mode === "explicit deselection")
			resumed.session.setActiveToolsByName(resumed.session.getActiveToolNames().filter((name) => name !== "browse"));
		expect(resumed.sessionManager.getBranch()).toEqual(original.sessionManager.getBranch());
		const managed = resumed.session.getActiveToolNames().includes("discover_tools");
		resumed.setResponses([
			...(managed && testCase.selection?.includes("browse") ? [discover()] : []),
			(context) => {
				expect(context.messages[0]).toEqual(original.session.messages[0]);
				if (!managed) expect(getCurrentSystemPrompt(context.messages)).toContain(full);
				expect.soft(getCurrentTools(context.messages).some((tool) => tool.name === "browse")).toBe(testCase.active);
				return fauxAssistantMessage(
					[
						fauxToolCall("browse", {}),
						...(testCase.selection?.includes("optional") ? [fauxToolCall("optional", {})] : []),
					],
					{ stopReason: "toolUse" },
				);
			},
			done(),
		]);
		await resumed.session.prompt("use the selected browser");
		expect.soft(getToolResult(resumed, "browse").isError).toBe(!testCase.active);
		for (const name of ["optional", "deselected"])
			expect(resumed.session.getActiveToolNames().includes(name)).toBe(testCase.selection?.includes(name) ?? false);
		if (testCase.selection?.includes("optional")) expect(getToolResult(resumed, "optional").isError).toBe(false);
		if (!testCase.active) {
			const next = await setup({
				initialActiveToolNames: undefined,
				sessionManager: savedBranch(resumed),
				extensionFactories: selectedOwners,
			});
			next.setResponses([
				...(next.session.getActiveToolNames().includes("discover_tools") ? [discover()] : []),
				fauxAssistantMessage([fauxToolCall("browse", {})], { stopReason: "toolUse" }),
				done(),
			]);
			await next.session.prompt("keep the recorded selection on default resume");
			expect(getToolResult(next, "browse").isError).toBe(true);
			expect(next.session.getActiveToolNames()).not.toContain("browse");
		}
		if (testCase.mode === "excluded discovery") {
			await resumed.session.navigateTree(original.sessionManager.getLeafId()!);
			expect(resumed.session.getActiveToolNames()).toContain("browse");
		}
	});

	it("retires deferrals lazily across delayed registration and exact working-session restore", async () => {
		const original = await suppressed();
		let register!: () => void;
		const resumed = await setup({
			initialActiveToolNames: undefined,
			sessionManager: savedBranch(original),
			excludedToolNames: ["discover_tools"],
			extensionFactories: [
				instructionGroupsExtension,
				(pi) => {
					register = () =>
						pi.registerTool({ ...original.session.getToolDefinition("browse")!, defaultActive: false });
				},
			],
		});
		const pending = await resumed.session.acquireWorkingSession();
		await pending.release();
		expect(pending.state.pendingTools).toContain("browse");
		expect(resumed.sessionManager.getBranch()).toEqual(original.sessionManager.getBranch());
		register();
		expect(resumed.session.getActiveToolNames()).toContain("browse");
		resumed.session.setActiveToolsByName(resumed.session.getActiveToolNames().filter((name) => name !== "browse"));
		const captured = await resumed.session.acquireWorkingSession();
		await captured.release();
		const restored = await createHarness({
			sessionManager: openWorkingSession(captured.state),
			extensionFactories: selectedOwners,
		});
		harnesses.push(restored);
		restored.session.restoreWorkingSession(captured.state);
		await restored.session.bindExtensions({});
		expect(restored.session.getActiveToolNames()).toEqual(captured.state.activeTools);
		expect(restored.sessionManager.getEntries()).toEqual(captured.state.entries);
		restored.setResponses([done()]);
		await restored.session.prompt("keep browser deselected");
		const unmanaged = await setup({
			initialActiveToolNames: undefined,
			sessionManager: savedBranch(restored),
			extensionFactories: selectedOwners,
			excludedToolNames: ["discover_tools"],
		});
		expect(unmanaged.session.getActiveToolNames()).not.toContain("browse");
		const { session: managed } = await createAgentSession({
			cwd: restored.tempDir,
			agentDir: restored.tempDir,
			model: restored.getModel(),
			modelRuntime: restored.session.modelRuntime,
			resourceLoader: restored.session.resourceLoader,
			sessionManager: savedBranch(restored),
			tools: ["+discover_tools", "+optional"],
		});
		try {
			await managed.bindExtensions({});
			restored.setResponses([
				discover(),
				() => {
					expect(
						managed.messages.findLast(
							(message) => message.role === "toolResult" && message.toolName === "discover_tools",
						),
					).toMatchObject({ isError: false });
					return fauxAssistantMessage([fauxToolCall("browse", {})], { stopReason: "toolUse" });
				},
				done(),
			]);
			await managed.prompt("discovery must not resurrect deselected browser");
			expect(
				managed.messages.findLast((message) => message.role === "toolResult" && message.toolName === "browse"),
			).toMatchObject({ isError: true });
			expect(managed.getActiveToolNames()).not.toContain("browse");
			expect(managed.getActiveToolNames()).toContain("optional");
		} finally {
			managed.dispose();
		}
	});

	it("hands deferred tools back when reload disables the builtin, without reselecting them on a later reload", async () => {
		const resources = await setup();
		const faux = fauxProvider();
		const settingsManager = SettingsManager.create(resources.tempDir, resources.tempDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd: resources.tempDir,
			agentDir: resources.tempDir,
			settingsManager,
			extensionFactories: [
				{ name: "instruction-groups", factory: instructionGroupsExtension, builtin: true, replaceable: true },
				owner,
				(pi) => pi.registerProvider(faux.provider),
			],
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: resources.tempDir,
			agentDir: resources.tempDir,
			model: faux.getModel(),
			modelRuntime: resources.session.modelRuntime,
			resourceLoader,
			settingsManager,
			sessionManager: SessionManager.inMemory(resources.tempDir),
		});
		try {
			const errors: string[] = [];
			await session.bindExtensions({ onError: (error) => errors.push(error.error) });
			faux.setResponses([done()]);
			await session.prompt("defer browser");
			expect(session.getActiveToolNames()).not.toContain("browse");
			writeFileSync(
				join(resources.tempDir, "settings.json"),
				JSON.stringify({ extensions: ["-builtin:instruction-groups"] }),
			);
			await session.reload();
			expect(session.getActiveToolNames()).toContain("browse");
			session.setActiveToolsByName(session.getActiveToolNames().filter((name) => name !== "browse"));
			await session.reload();
			expect(session.getActiveToolNames()).not.toContain("browse");
			faux.setResponses([fauxAssistantMessage([fauxToolCall("browse", {})], { stopReason: "toolUse" }), done()]);
			await session.prompt("keep browser deselected after reload");
			expect(
				session.messages.findLast((message) => message.role === "toolResult" && message.toolName === "browse"),
			).toMatchObject({ isError: true, content: [{ type: "text", text: "Tool browse not found" }] });
			expect(errors).toEqual([]);
		} finally {
			session.dispose();
		}
	});

	it.each(["direct", "codemode-only"] as const)(
		"advertises sorted permitted capabilities before discovery in %s mode without activation or index churn",
		async (mode) => {
			const harness = await setup({
				initialActiveToolNames: mode === "codemode-only" ? ["codemode"] : [],
				extensionFactories: [
					instructionGroupsExtension,
					owner,
					(pi) => {
						pi.events.on("pi:instruction-groups", (data) => {
							const collector = data as InstructionGroupCollector;
							for (const group of [
								{ name: "zeta", description: "Unrelated actions", tools: ["plain"] },
								{ name: "denied", description: "Hidden capability", tools: ["hidden"] },
								{ name: "alpha", description: "Nested actions", tools: ["nested"] },
							])
								collector.register({ ...group, instructions: () => later });
						});
					},
					...(mode === "codemode-only" ? [createCodemodeExtension({ mode: "only" })] : []),
				],
			});
			const requests: TranscriptContext[] = [];
			const reachable = mode === "direct" ? "discover_tools" : "codemode";
			const call = (args: { enable?: string[] }) =>
				mode === "direct"
					? fauxAssistantMessage([fauxToolCall("discover_tools", args)], { stopReason: "toolUse" })
					: script(`return await tools.discover_tools(${JSON.stringify(args)});`);
			harness.setResponses([
				(context) => {
					requests.push(structuredClone(context));
					return call({});
				},
				(context) => {
					requests.push(structuredClone(context));
					return call({ enable: ["browser"] });
				},
				(context) => {
					requests.push(structuredClone(context));
					return done();
				},
			]);
			await harness.session.prompt("Find available capabilities");
			harness.setResponses([
				(context) => {
					requests.push(structuredClone(context));
					return done();
				},
			]);
			await harness.session.prompt("Continue after enabling");
			expect(requests).toHaveLength(4);
			const sections = getCurrentSystemMessage(requests[0].messages)?.sections;
			const index = sections?.instruction_groups;
			expect(index).toBeDefined();
			expect(index?.split("\n").filter((line) => line.startsWith("- "))).toEqual([
				"- alpha: Nested actions",
				"- browser: Browser actions",
				"- zeta: Unrelated actions",
			]);
			expect(sections?.tools).toMatch(new RegExp(`${reachable}: .+`));
			const tools = getCurrentTools(requests[0].messages);
			const declaration = JSON.stringify(tools.find((tool) => tool.name === reachable));
			expect(tools.map((tool) => tool.name)).toContain(reachable);
			expect(declaration).toContain("discover_tools");
			expect(tools.map((tool) => tool.name)).not.toContain("browse");
			if (mode === "codemode-only") {
				expect(tools.map((tool) => tool.name)).not.toContain("plain");
				expect(tools.map((tool) => tool.name)).not.toContain("discover_tools");
			}
			for (const request of requests) {
				expect(getCurrentSystemMessage(request.messages)?.sections?.instruction_groups).toBe(index);
				expect(JSON.stringify(request.messages)).not.toContain("Hidden capability");
				expect(JSON.stringify(request.messages)).not.toContain(later);
			}
			// Codemode-only lists browse in the codemode declaration once enabling makes it callable.
			for (const request of mode === "direct" ? requests : requests.slice(0, 2))
				expect(JSON.stringify(getCurrentTools(request.messages).find((tool) => tool.name === reachable))).toBe(
					declaration,
				);
			for (const request of requests.slice(0, 2)) expect(JSON.stringify(request.messages)).not.toContain(full);
			expect(JSON.stringify(requests[3].messages)).toContain(full);
			expect(harness.session.getCallableToolNames()).toContain("discover_tools");
			expect(harness.session.getActiveToolNames()).toContain("browse");
			expect(harness.session.getActiveToolNames()).not.toContain("optional");
			expect(harness.session.getCallableToolNames()).not.toContain("hidden");
		},
	);

	it.each([
		{ boundary: "session_start", discard: false, selection: ["late"], allowlist: undefined },
		{ boundary: "session_tree", discard: false, selection: ["late"], allowlist: undefined },
		{ boundary: "session_start", discard: true, selection: ["late"], allowlist: undefined },
		{ boundary: "session_start", discard: false, selection: ["read"], allowlist: ["read", "bash"] },
		{ boundary: "session_tree", discard: false, selection: ["read"], allowlist: ["read", "bash"] },
		{ boundary: "session_start", discard: false, selection: [], allowlist: ["read", "bash"] },
		{ boundary: "session_tree", discard: false, selection: [], allowlist: ["read", "bash"] },
	])(
		"resyncs saved $selection at $boundary under $allowlist; explicit empty discard=$discard",
		async ({ boundary, discard, selection, allowlist }) => {
			const late = {
				name: "late",
				label: "Late",
				description: "Reconnect-only saved tool",
				exposure: "deferred" as const,
				defaultActive: false,
				parameters: Type.Object({}),
				execute: async () => ({ content: [], details: undefined }),
			};
			const original = await setup({
				initialActiveToolNames: selection,
				allowedToolNames: allowlist,
				extensionFactories: [instructionGroupsExtension, (pi) => pi.registerTool(late)],
			});
			if (boundary === "session_tree" && !allowlist) {
				// Tree navigation activates extension tools the branch never declared, so declare
				// discover_tools before the selection removes it.
				original.session.setActiveToolsByName([...selection, "discover_tools"]);
				original.setResponses([done()]);
				await original.session.prompt("declare discovery");
			}
			original.session.setActiveToolsByName(selection);
			original.setResponses([done(), done()]);
			await original.session.prompt("first branch point");
			const first = original.sessionManager.getLeafId()!;
			await original.session.prompt("saved leaf");
			const captured = await original.session.acquireWorkingSession();
			await captured.release();
			expect(captured.state.activeTools).toEqual(selection);
			expect(captured.state.allowedTools).toEqual(allowlist);
			let register!: () => void;
			const restored = await createHarness({
				initialActiveToolNames: [],
				sessionManager: openWorkingSession(captured.state),
				extensionFactories: [
					instructionGroupsExtension,
					(pi) => {
						register = () => pi.registerTool(late);
					},
				],
			});
			harnesses.push(restored);
			const errors: string[] = [];
			const bindings = { onError: (error: { error: string }) => errors.push(error.error) };
			if (boundary === "session_tree") await restored.session.bindExtensions(bindings);
			restored.session.restoreWorkingSession(captured.state);
			const active = allowlist ? selection : [];
			expect(restored.session.getActiveToolNames()).toEqual(active);
			if (boundary === "session_start") await restored.session.bindExtensions(bindings);
			else await restored.session.navigateTree(first);
			expect(errors).toEqual([]);
			expect(restored.session.getActiveToolNames()).toEqual(active);
			if (discard) restored.session.setActiveToolsByName([]);
			const pending = await restored.session.acquireWorkingSession();
			try {
				expect(pending.state.pendingTools).toEqual(discard || allowlist ? [] : ["late"]);
			} finally {
				await pending.release();
			}
			if (!discard && !allowlist) {
				await expect(restored.session.prompt("wait for reconnect")).rejects.toThrow(
					"Saved tools have not registered",
				);
				expect(restored.faux.state.callCount).toBe(0);
			}
			if (!allowlist) register();
			const expected = allowlist ? selection : discard ? [] : ["late"];
			expect(restored.session.getActiveToolNames()).toEqual(expected);
			restored.setResponses([
				(context) => {
					expect(getCurrentTools(context.messages).map((tool) => tool.name)).toEqual(expected);
					return done();
				},
			]);
			await restored.session.prompt("new input after reconnect");
			expect(restored.faux.state.callCount).toBe(1);
		},
	);

	it.each(["parallel", "sequential"] as const)(
		"gates direct, nested, and codemode calls until the next read in %s execution",
		async (mode) => {
			const harness = await setup({
				initialActiveToolNames: ["codemode"],
				extensionFactories: [instructionGroupsExtension, owner, createCodemodeExtension()],
			});
			harness.session.agent.toolExecution = mode;
			const active = harness.session.getActiveToolNames();
			const callable = harness.session.getCallableToolNames();
			harness.setResponses([
				(context) => {
					expect(getCurrentTools(context.messages).map((tool) => tool.name)).not.toContain("browse");
					expect(JSON.stringify(context.messages)).not.toContain(full);
					return fauxAssistantMessage(
						[
							fauxToolCall("discover_tools", { enable: ["browser"] }),
							fauxToolCall("browse", {}),
							fauxToolCall("nested", {}),
							fauxToolCall("codemode", { code: "return await tools.browse({});" }),
							fauxToolCall("plain", {}),
						],
						{ stopReason: "toolUse" },
					);
				},
				(context) => {
					expect(JSON.stringify(context.messages)).toContain(full);
					expect(getCurrentTools(context.messages).map((tool) => tool.name)).toContain("browse");
					expect(JSON.stringify(getToolResult(harness, "browse").content)).toContain("not found");
					for (const name of ["nested", "codemode"])
						expect(JSON.stringify(getToolResult(harness, name).content)).toContain("prior turn");
					expect(getToolResult(harness, "plain")).toMatchObject({
						isError: false,
						content: [{ type: "text", text: "plain ran" }],
					});
					return fauxAssistantMessage(
						[
							fauxToolCall("browse", {}),
							fauxToolCall("nested", {}),
							fauxToolCall("codemode", { code: "return await tools.browse({});" }),
						],
						{ stopReason: "toolUse" },
					);
				},
				done(),
			]);
			await harness.session.prompt("discover and act");
			for (const name of ["browse", "nested", "codemode"]) {
				expect(getToolResult(harness, name).isError).toBe(false);
				expect(JSON.stringify(getToolResult(harness, name).content)).toContain("acted");
			}
			expect(harness.session.getActiveToolNames()).toEqual([
				...active.filter((name) => name !== "browse"),
				"browse",
			]);
			expect(harness.session.getCallableToolNames()).toEqual(callable);
			expect(active).not.toContain("optional");
			expect(callable).not.toContain("hidden");
			expect(callable).toContain("discover_tools");
		},
	);

	const blockedBrowse = "await tools.browse({}).catch(() => {});";
	it.each([
		{
			outcome: "discards its output",
			mode: "on",
			code: `await tools.discover_tools({ enable: ["browser"] });\n${blockedBrowse}\nreturn "finished";`,
		},
		{
			outcome: "rejects after enabling",
			mode: "on",
			code: `await tools.discover_tools({ enable: ["browser"] });\n${blockedBrowse}\nthrow new Error("after enabling");`,
		},
		{
			outcome: "truncates its output",
			mode: "on",
			code: `// @options: {"max_output_tokens": 20}\nconst receipt = await tools.discover_tools({ enable: ["browser"] });\n${blockedBrowse}\nreturn "filler ".repeat(400) + receipt;`,
		},
		{
			outcome: "runs in codemode-only mode",
			mode: "only",
			code: `await tools.discover_tools({ enable: ["browser"] });\n${blockedBrowse}\nreturn "finished";`,
		},
	] as const)(
		"delivers full instructions once before the next request when a codemode script $outcome",
		async ({ mode, code }) => {
			const harness = await setup({
				initialActiveToolNames: ["codemode"],
				extensionFactories: [
					instructionGroupsExtension,
					(pi: ExtensionAPI) => owner(pi, "codemode"),
					createCodemodeExtension({ mode }),
				],
			});
			const requests: TranscriptContext[] = [];
			harness.setResponses([
				(context) => {
					requests.push(structuredClone(context));
					return script(code);
				},
				(context) => {
					requests.push(structuredClone(context));
					return script("return await tools.browse({});");
				},
				done(),
			]);
			await harness.session.prompt("discover inside a script");
			const delivered = harness.sessionManager.getBranch().filter((entry) => entry.type === "custom_message");
			expect(delivered).toHaveLength(1);
			expect(delivered[0]).toMatchObject({ customType: "pi:instruction-groups:instructions", display: false });
			expect(getMessageText(delivered[0])).toBe(`## browser\n\n${full}`);
			const [before, after] = requests;
			expect(getCurrentTools(before.messages).some((tool) => tool.name === "discover_tools")).toBe(mode === "on");
			expect(JSON.stringify(before.messages)).not.toContain(full);
			expect(after.messages.slice(0, before.messages.length)).toEqual(before.messages);
			expect(JSON.stringify(after.messages).split(full)).toHaveLength(2);
			for (const message of harness.session.messages)
				if (message.role === "toolResult" && message.toolName === "codemode")
					expect(getMessageText(message)).not.toContain(full);
			const [sameScript] = harness
				.eventsOfType("tool_execution_end")
				.filter((event) => event.toolName === "browse" && event.parentToolCallId);
			expect(sameScript).toMatchObject({ isError: true });
			expect(JSON.stringify(sameScript.result)).toContain("prior turn");
			const action = getToolResult(harness, "codemode");
			expect(action.isError).toBe(false);
			expect(getMessageText(action)).toContain("acted");
		},
	);

	it.each(["direct", "discarded script", "failed script"] as const)(
		"keeps one full copy per enabled group on a subsequent run after %s",
		async (path) => {
			const harness = await setup({
				initialActiveToolNames: ["codemode"],
				extensionFactories: [...selectedOwners, createCodemodeExtension()],
			});
			const requests: TranscriptContext[] = [];
			const enable = { enable: ["browser", "other"] };
			const first =
				path === "direct"
					? discover(enable.enable)
					: script(
							`await tools.discover_tools(${JSON.stringify(enable)}); ${
								path === "failed script" ? 'throw new Error("after discovery");' : 'return "discarded";'
							}`,
						);
			const act = (context: TranscriptContext) => {
				requests.push(structuredClone(context));
				return fauxAssistantMessage([fauxToolCall("browse", {}), fauxToolCall("deselected", {})], {
					stopReason: "toolUse",
				});
			};
			harness.setResponses([first, act, done()]);
			await harness.session.prompt("enable both groups");
			expect(getToolResult(harness, "browse").isError).toBe(false);
			expect(getToolResult(harness, "deselected").isError).toBe(false);
			harness.setResponses([act, done()]);
			await harness.session.prompt("use both groups again");
			expect(getToolResult(harness, "browse").isError).toBe(false);
			expect(getToolResult(harness, "deselected").isError).toBe(false);
			for (const request of requests) {
				const body = JSON.stringify(request.messages);
				expect(body.split(full)).toHaveLength(2);
				expect(body.split(later)).toHaveLength(2);
			}
			if (path === "direct") {
				harness.setResponses([
					discover(enable.enable),
					(context) => {
						const body = JSON.stringify(context.messages);
						expect(body.split(full)).toHaveLength(3);
						expect(body.split(later)).toHaveLength(3);
						return done();
					},
				]);
				await harness.session.prompt("explicitly rediscover both groups");
				expect(getToolResult(harness, "discover_tools").content).toEqual([
					{ type: "text", text: `## browser\n\n${full}\n\n## other\n\n${later}` },
				]);
			}
		},
	);

	it.each(["direct", "codemode"] as const)(
		"delivers the latest complete %s instructions when project guidance is added, removed, or restored",
		async (path) => {
			const withProject = `${full}\n\nProject browser config: use this profile.`;
			let current = withProject;
			const requests: TranscriptContext[] = [];
			const harness = await setup({
				...(path === "codemode" ? { initialActiveToolNames: ["codemode"] } : {}),
				extensionFactories: [
					instructionGroupsExtension,
					(pi) => owner(pi, "direct", () => current),
					...(path === "codemode" ? [createCodemodeExtension()] : []),
				],
			});
			harness.setResponses([discoverVia(path), done()]);
			await harness.session.prompt("enable browser with project config");
			for (const text of [full, withProject, full]) {
				current = text;
				harness.setResponses([
					(context) => {
						requests.push(structuredClone(context));
						return fauxAssistantMessage([fauxToolCall("browse", {})], { stopReason: "toolUse" });
					},
					done(),
				]);
				await harness.session.prompt("use browser after configuration changed");
				expect(getToolResult(harness, "browse").isError).toBe(false);
				const deliveries = harness.sessionManager
					.getBranch()
					.filter(
						(entry) =>
							entry.type === "custom_message" && entry.customType === "pi:instruction-groups:instructions",
					);
				expect(getMessageText(deliveries.at(-1))).toBe(`## browser\n\n${text}`);
				expect(requests.at(-1)!.messages.some((message) => getMessageText(message).includes(text))).toBe(true);
			}
			const deliveriesBefore = harness.sessionManager
				.getBranch()
				.filter(
					(entry) => entry.type === "custom_message" && entry.customType === "pi:instruction-groups:instructions",
				);
			harness.setResponses([done()]);
			await harness.session.prompt("unchanged configuration");
			const deliveriesAfter = harness.sessionManager
				.getBranch()
				.filter(
					(entry) => entry.type === "custom_message" && entry.customType === "pi:instruction-groups:instructions",
				);
			expect(deliveriesAfter).toHaveLength(deliveriesBefore.length);
		},
	);

	it("keeps separate group sections intact when owner instructions contain another group heading", async () => {
		const browserText = `${full}\n\n## other\n\nA browser owner's own heading.`;
		const harness = await setup({
			extensionFactories: [
				instructionGroupsExtension,
				(pi) => owner(pi, "direct", () => browserText),
				(pi) =>
					pi.events.on("pi:instruction-groups", (data) =>
						(data as InstructionGroupCollector).register({
							name: "other",
							description: "Other",
							tools: ["plain"],
							instructions: () => later,
						}),
					),
			],
		});
		harness.setResponses([discover(["browser", "other"]), done()]);
		await harness.session.prompt("enable groups");
		let request: TranscriptContext | undefined;
		harness.setResponses([
			(context) => {
				request = structuredClone(context);
				return fauxAssistantMessage([fauxToolCall("browse", {}), fauxToolCall("plain", {})], {
					stopReason: "toolUse",
				});
			},
			done(),
		]);
		await harness.session.prompt("use groups");
		expect(getToolResult(harness, "browse").isError).toBe(false);
		expect(getToolResult(harness, "plain").isError).toBe(false);
		expect(JSON.stringify(request!.messages).split(full)).toHaveLength(2);
		expect(JSON.stringify(request!.messages).split(later)).toHaveLength(2);
	});

	it.each(["direct", "codemode"] as const)(
		"reuses old %s discovery anchors without section metadata after resume",
		async (path) => {
			const options = {
				initialActiveToolNames: ["codemode"],
				extensionFactories: [...selectedOwners, createCodemodeExtension()],
			};
			const original = await setup(options);
			original.setResponses([discoverVia(path, ["browser", "other"]), done()]);
			await original.session.prompt("enable groups");
			const entries = structuredClone([
				original.sessionManager.getHeader()!,
				...original.sessionManager.getBranch(),
			]);
			for (const entry of entries) {
				if (
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					entry.message.toolName === "discover_tools"
				)
					delete entry.message.details;
				if (entry.type === "custom_message" && entry.customType === "pi:instruction-groups:instructions")
					delete entry.details;
			}
			const resumed = await setup({
				...options,
				sessionManager: SessionManager.inMemory(original.tempDir, undefined, entries),
			});
			let request: TranscriptContext | undefined;
			resumed.setResponses([
				(context) => {
					request = structuredClone(context);
					return fauxAssistantMessage([fauxToolCall("browse", {}), fauxToolCall("deselected", {})], {
						stopReason: "toolUse",
					});
				},
				done(),
			]);
			await resumed.session.prompt("use groups after resume");
			expect(getToolResult(resumed, "browse").isError).toBe(false);
			expect(getToolResult(resumed, "deselected").isError).toBe(false);
			expect(JSON.stringify(request!.messages).split(full)).toHaveLength(2);
			expect(JSON.stringify(request!.messages).split(later)).toHaveLength(2);
		},
	);

	const codemodeOptions = {
		initialActiveToolNames: ["codemode"],
		extensionFactories: [instructionGroupsExtension, owner, createCodemodeExtension()],
	};
	it.each([
		{
			name: "direct discovery",
			options: {},
			step: discover(),
			check: (harness: Harness) =>
				expect(getToolResult(harness, "discover_tools")).toMatchObject({
					isError: false,
					content: [{ type: "text", text: `## browser\n\n${full}` }],
				}),
			instructions: 1,
		},
		{
			name: "listing from a script",
			options: codemodeOptions,
			step: script("return await tools.discover_tools({});"),
			check: (harness: Harness) => {
				expect(getToolResult(harness, "codemode").isError).toBe(false);
				expect(getMessageText(getToolResult(harness, "codemode"))).toContain("browser: Browser actions");
			},
			instructions: 0,
		},
		{
			name: "a failed script enable",
			options: { ...codemodeOptions, excludedToolNames: ["browse", "optional", "hidden"] },
			step: discoverVia("codemode"),
			check: (harness: Harness) => {
				expect(getToolResult(harness, "codemode").isError).toBe(true);
				expect(getMessageText(getToolResult(harness, "codemode"))).toContain(
					"Unavailable instruction group: browser",
				);
			},
			instructions: 0,
		},
	])("adds no separate instruction message for $name", async ({ options, step, check, instructions }) => {
		const harness = await setup(options);
		let next: TranscriptContext | undefined;
		harness.setResponses([
			step,
			(context) => {
				next = structuredClone(context);
				return done();
			},
		]);
		await harness.session.prompt("discover");
		check(harness);
		expect(JSON.stringify(next?.messages).split(full)).toHaveLength(instructions + 1);
	});

	it("enables groups from a background script and delivers full instructions before its completion turn", async () => {
		const release = Promise.withResolvers<void>();
		const harness = await setup({
			initialActiveToolNames: ["codemode"],
			extensionFactories: [
				instructionGroupsExtension,
				owner,
				createCodemodeExtension(),
				(pi) =>
					pi.registerTool({
						name: "wait",
						label: "wait",
						description: "Waits for the test",
						exposure: "codemode",
						parameters: Type.Object({}),
						execute: async () => {
							await release.promise;
							return { content: [{ type: "text", text: "released" }], details: undefined };
						},
					}),
			],
		});
		let completionRequest: TranscriptContext | undefined;
		harness.setResponses([
			script(
				'// @options: {"background": true}\nawait tools.wait({});\nreturn await tools.discover_tools({ enable: ["browser"] });',
			),
			done(),
			(context) => {
				completionRequest = structuredClone(context);
				return fauxAssistantMessage([fauxToolCall("browse", {})], { stopReason: "toolUse" });
			},
			done(),
		]);
		await harness.session.prompt("discover in the background");
		expect(harness.session.getActiveToolNames()).not.toContain("browse");
		release.resolve();
		await vi.waitFor(() => expect(harness.getPendingResponseCount()).toBe(0));
		await harness.session.waitForIdle();
		expect(JSON.stringify(completionRequest?.messages)).toContain(full);
		const completion = harness.session.messages.findLast(
			(message) => message.role === "custom" && message.customType === "codemode-background",
		);
		expect(getMessageText(completion)).toContain("completed");
		expect(getMessageText(completion)).not.toContain(full);
		expect(getToolResult(harness, "browse")).toMatchObject({
			isError: false,
			content: [{ type: "text", text: "acted" }],
		});
	});

	it("lists without enabling and rejects unavailable or duplicate enables without changing state", async () => {
		const harness = await setup();
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("discover_tools", {})], { stopReason: "toolUse" }),
			(context) => {
				expect(getToolResult(harness, "discover_tools").content).toEqual([
					{ type: "text", text: "browser: Browser actions" },
				]);
				expect(getCurrentTools(context.messages).map((tool) => tool.name)).not.toContain("browse");
				return fauxAssistantMessage([fauxToolCall("discover_tools", { enable: ["browser", "missing"] })], {
					stopReason: "toolUse",
				});
			},
			() => {
				expect(getToolResult(harness, "discover_tools").isError).toBe(true);
				return fauxAssistantMessage([fauxToolCall("discover_tools", { enable: ["browser", "browser"] })], {
					stopReason: "toolUse",
				});
			},
			done(),
		]);
		await harness.session.prompt("list and invalid enables");
		expect(getToolResult(harness, "discover_tools").isError).toBe(true);
		expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "custom")).toMatchObject([
			{ data: { enabled: [], inactive: ["browse"] } },
		]);
	});

	it("respects exclusions and allowlists, and keeps owners eager when discovery is inactive", async () => {
		for (const options of [
			{ excludedToolNames: ["browse", "optional", "hidden"] },
			{ allowedToolNames: ["discover_tools", "plain"] },
		]) {
			const denied = await setup(options);
			denied.setResponses([
				(context) => {
					expect(JSON.stringify(context.messages)).not.toContain("Browser actions");
					return fauxAssistantMessage([fauxToolCall("discover_tools", {})], { stopReason: "toolUse" });
				},
				done(),
			]);
			await denied.session.prompt("list");
			expect(getToolResult(denied, "discover_tools").content).toEqual([
				{ type: "text", text: "No instruction groups available." },
			]);
		}
		const eager = await setup({ excludedToolNames: ["discover_tools"] });
		eager.setResponses([
			(context) => {
				expect(JSON.stringify(context.messages)).toContain(full);
				expect(getCurrentSystemMessage(context.messages)?.sections).not.toHaveProperty("instruction_groups");
				expect(getCurrentTools(context.messages).map((tool) => tool.name)).toContain("browse");
				return fauxAssistantMessage([fauxToolCall("browse", {})], { stopReason: "toolUse" });
			},
			done(),
		]);
		await eager.session.prompt("act");
		expect(getToolResult(eager, "browse").isError).toBe(false);
	});

	it("collects synchronously and rejects invalid, duplicate, and late registrations", async () => {
		let collector: InstructionGroupCollector | undefined;
		const errors: string[] = [];
		await setup({
			extensionFactories: [
				instructionGroupsExtension,
				owner,
				(pi) => {
					pi.events.on("pi:instruction-groups", (data) => {
						collector = data as InstructionGroupCollector;
						for (const group of [
							{ name: "browser", description: "duplicate", tools: ["browse"], instructions: () => full },
							{ name: "invalid", description: "invalid", tools: ["discover_tools"], instructions: () => full },
						]) {
							try {
								collector.register(group);
							} catch (error) {
								errors.push(error instanceof Error ? error.message : String(error));
							}
						}
					});
				},
			],
		});
		expect(collector).toBeDefined();
		expect(collector?.isManaged()).toBe(true);
		expect(errors).toEqual(["Invalid or duplicate instruction group", "Invalid or duplicate instruction group"]);
		expect(() =>
			collector?.register({ name: "late", description: "late", tools: ["browse"], instructions: () => full }),
		).toThrow("must register synchronously");
	});

	it.each(["forced", "superseded"] as const)(
		"does not authorize full instructions removed from the effective %s prompt",
		async (projection) => {
			let prune = false;
			const harness = await setup({
				extensionFactories: [
					instructionGroupsExtension,
					owner,
					(pi) => {
						pi.on("before_agent_start", (event) => {
							if (projection === "forced") event.systemPromptOptions.forceSystemPrompt = "Forced prompt";
							else if (prune) event.systemPromptOptions.appendSystemPrompt = "";
						});
						pi.on("context", (event) => {
							if (!prune) return;
							if (projection === "forced")
								return { messages: event.messages.filter((message) => message.role === "user") };
							for (const message of event.messages) {
								if (message.role === "toolResult" && message.toolName === "discover_tools")
									message.content = [{ type: "text", text: "Result omitted" }];
							}
						});
					},
				],
			});
			harness.setResponses([discover(), done()]);
			await harness.session.prompt("enable");
			harness.setResponses([done()]);
			await harness.session.prompt("persist instruction section");
			prune = true;
			harness.setResponses([
				(context) => {
					expect(JSON.stringify(collapseSystemMessages(context))).not.toContain(full);
					return fauxAssistantMessage([fauxToolCall("browse", {})], { stopReason: "toolUse" });
				},
				done(),
			]);
			await harness.session.prompt("act");
			expect(getToolResult(harness, "browse").isError).toBe(true);
		},
	);

	it("restores only the selected branch on tree navigation, then restores enabled names in a fresh runtime", async () => {
		const harness = await setup();
		harness.setResponses([done()]);
		await harness.session.prompt("before");
		const before = harness.sessionManager.getLeafId()!;
		const pending = await setup({
			sessionManager: SessionManager.inMemory(harness.tempDir, undefined, [
				harness.sessionManager.getHeader()!,
				...harness.sessionManager.getBranch(),
			]),
		});
		pending.setResponses([discover(), done()]);
		await pending.session.prompt("enable after resume");
		expect(pending.session.getActiveToolNames()).toContain("browse");
		expect(pending.session.getActiveToolNames()).not.toContain("optional");
		harness.setResponses([discover(), done()]);
		await harness.session.prompt("enable");
		const after = harness.sessionManager.getLeafId()!;
		await harness.session.navigateTree(before);
		expect(harness.session.getActiveToolNames()).not.toContain("browse");
		harness.setResponses([
			(context) => {
				expect(getCurrentTools(context.messages).map((tool) => tool.name)).not.toContain("browse");
				expect(JSON.stringify(context.messages)).not.toContain(full);
				return discover();
			},
			() => {
				expect.soft(getToolResult(harness, "discover_tools").isError).toBe(false);
				return fauxAssistantMessage([fauxToolCall("browse", {})], { stopReason: "toolUse" });
			},
			done(),
		]);
		await harness.session.prompt("old branch");
		expect(getToolResult(harness, "browse").isError).toBe(false);
		expect(harness.session.getActiveToolNames()).toContain("browse");
		await harness.session.navigateTree(after);
		harness.setResponses([
			(context) => {
				expect(getCurrentTools(context.messages).map((tool) => tool.name)).toContain("browse");
				return fauxAssistantMessage([fauxToolCall("browse", {})], { stopReason: "toolUse" });
			},
			done(),
		]);
		await harness.session.prompt("enabled branch");
		expect(getToolResult(harness, "browse").isError).toBe(false);
		const restored = await setup({
			sessionManager: SessionManager.inMemory(harness.tempDir, undefined, [
				harness.sessionManager.getHeader()!,
				...harness.sessionManager.getBranch(),
			]),
		});
		restored.setResponses([
			(context) => {
				expect(getCurrentTools(context.messages).map((tool) => tool.name)).toContain("browse");
				expect(JSON.stringify(context.messages).split(full)).toHaveLength(2);
				return fauxAssistantMessage([fauxToolCall("browse", {})], { stopReason: "toolUse" });
			},
			done(),
		]);
		await restored.session.prompt("resumed");
		expect(getToolResult(restored, "browse").isError).toBe(false);
		expect(restored.session.getActiveToolNames()).not.toContain("optional");
	});

	it.each(["direct", "codemode"] as const)(
		"repairs only groups enabled at each compaction boundary, including after resume, with %s discovery",
		async (path) => {
			const repairs: unknown[] = [];
			const extra = (pi: ExtensionAPI) => {
				pi.events.on("pi:instruction-groups", (data) =>
					(data as InstructionGroupCollector).register({
						name: "later",
						description: "Later",
						tools: ["nested"],
						instructions: () => later,
					}),
				);
				pi.on("session_before_compact", (event) => ({
					compaction: {
						summary: "compacted",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
					},
				}));
				pi.on("context_with_system", (event) => {
					const index = event.messages.findLastIndex((message) => message.role === "compactionSummary");
					if (index >= 0) repairs.push(event.messages[index + 1]);
				});
			};
			const options = {
				settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
				...(path === "codemode" ? { initialActiveToolNames: ["codemode"] } : {}),
				extensionFactories: [
					instructionGroupsExtension,
					owner,
					extra,
					...(path === "codemode" ? [createCodemodeExtension()] : []),
				],
			};
			const harness = await setup(options);
			harness.setResponses([discoverVia(path), done()]);
			await harness.session.prompt("enable browser");
			const discoveryAnchor = (message: (typeof harness.session.messages)[number]) =>
				path === "direct"
					? message.role === "toolResult" && message.toolName === "discover_tools"
					: message.role === "custom" && message.customType === "pi:instruction-groups:instructions";
			expect(harness.session.messages.some(discoveryAnchor)).toBe(true);
			await harness.session.compact();
			expect(harness.session.messages.some(discoveryAnchor)).toBe(false);
			const boundary = harness.sessionManager.getBranch().findLast((entry) => entry.type === "compaction")!;
			harness.setResponses([discoverVia(path, ["later"]), done()]);
			await harness.session.prompt("enable later");
			expect(repairs).toHaveLength(2);
			expect(repairs[0]).toEqual(repairs[1]);
			expect(repairs[0]).toMatchObject({
				role: "custom",
				display: false,
				content: `## browser\n\n${full}`,
				timestamp: Date.parse(boundary.timestamp),
			});
			const resumed = await setup({
				...options,
				sessionManager: SessionManager.inMemory(harness.tempDir, undefined, [
					harness.sessionManager.getHeader()!,
					...harness.sessionManager.getBranch(),
				]),
			});
			resumed.setResponses([done()]);
			await resumed.session.prompt("resume after compaction");
			expect(repairs.at(-1)).toEqual(repairs[0]);
			await resumed.session.compact();
			resumed.setResponses([done()]);
			await resumed.session.prompt("after second compaction");
			expect(repairs.at(-1)).toMatchObject({ content: `## browser\n\n${full}\n\n## later\n\n${later}` });
		},
	);

	it.each(["unchanged", "changed"] as const)(
		"does not repair a %s instruction anchor retained by compaction",
		async (state) => {
			let current = full;
			let firstKeptEntryId = "";
			const requests: AgentMessage[][] = [];
			const harness = await setup({
				settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
				extensionFactories: [
					instructionGroupsExtension,
					(pi) => owner(pi, "direct", () => current),
					(pi) => {
						pi.on("session_before_compact", (event) => ({
							compaction: {
								summary: "earlier context",
								firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						}));
						pi.on("context_with_system", (event) => {
							if (event.messages.some((message) => message.role === "compactionSummary"))
								requests.push(structuredClone(event.messages));
						});
					},
				],
			});
			harness.setResponses([done(), discover(), done()]);
			await harness.session.prompt("earlier");
			await harness.session.prompt("enable browser");
			firstKeptEntryId = harness.sessionManager
				.getBranch()
				.find((entry) => entry.type === "message" && getMessageText(entry.message) === "enable browser")!.id;
			await harness.session.compact();
			if (state === "changed") current = `${full}\n\nProject browser config: use this profile.`;
			harness.setResponses([fauxAssistantMessage([fauxToolCall("browse", {})], { stopReason: "toolUse" }), done()]);
			await harness.session.prompt("use retained instructions");
			expect(getToolResult(harness, "browse").isError).toBe(false);
			const messages = requests[0];
			expect(
				messages.some(
					(message) => message.role === "custom" && message.customType === "pi:instruction-groups:compaction",
				),
			).toBe(false);
			const anchors = messages.filter(
				(message) =>
					(message.role === "toolResult" && message.toolName === "discover_tools") ||
					(message.role === "custom" && message.customType === "pi:instruction-groups:instructions"),
			);
			expect(anchors).toHaveLength(state === "changed" ? 2 : 1);
			expect(getMessageText(anchors.at(-1))).toBe(`## browser\n\n${current}`);
		},
	);

	it.each(["direct", "codemode"] as const)(
		"keeps %s discovery available through automatic compaction mid-run",
		async (path) => {
			const large = full + " guidance".repeat(1800);
			const compactedRequests: { headRole: string; copies: number }[] = [];
			const harness = await setup({
				models: [{ id: "faux-1", contextWindow: 12000, maxTokens: 100 }],
				settings: { compaction: { enabled: true, reserveTokens: 6000, keepRecentTokens: 1 } },
				...(path === "codemode" ? { initialActiveToolNames: ["codemode"] } : {}),
				extensionFactories: [
					instructionGroupsExtension,
					...(path === "codemode" ? [createCodemodeExtension()] : []),
					(pi) => {
						pi.events.on("pi:instruction-groups", (data) =>
							(data as InstructionGroupCollector).register({
								name: "browser",
								description: "Browser",
								tools: ["browse"],
								instructions: () => large,
							}),
						);
						pi.registerTool({
							name: "browse",
							label: "browse",
							description: "browse",
							parameters: Type.Object({}),
							execute: async () => ({ content: [{ type: "text", text: "acted" }], details: undefined }),
						});
						pi.on("session_before_compact", (event) => ({
							compaction: {
								summary: "summary without instructions",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						}));
						pi.on("context_with_system", (event) => {
							const index = event.messages.findLastIndex((message) => message.role === "compactionSummary");
							if (index < 0) return;
							const copies = JSON.stringify(event.messages).split(large).length - 1;
							if (copies) compactedRequests.push({ headRole: event.messages[0].role, copies });
						});
					},
				],
			});
			harness.setResponses([done()]);
			await harness.session.prompt("Earlier context ".repeat(800));
			harness.setResponses([
				discoverVia(path),
				fauxAssistantMessage([fauxToolCall("browse", {})], { stopReason: "toolUse" }),
				done(),
			]);
			await harness.session.prompt("discover then act");
			expect(harness.eventsOfType("compaction_end").length).toBeGreaterThan(0);
			expect(compactedRequests.length).toBeGreaterThan(0);
			for (const request of compactedRequests) expect(request).toEqual({ headRole: "system", copies: 1 });
			expect(getToolResult(harness, "browse").isError).toBe(false);
		},
	);
});
