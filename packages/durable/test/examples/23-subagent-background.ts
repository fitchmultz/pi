// A background subagent tool: the call starts a named subagent and returns at once. One commit creates a background
// supervisor task, a child conversation it owns, and an entry in the parent's `app.subagents` document. The supervisor
// submits the task with a stable request ID, so a crash before or after admission never submits twice. Abort and idle
// waits of the parent stop at the supervisor, so the parent answers while the subagent keeps working.
// Uses OpenAI when OPENAI_API_KEY is set, and a scripted faux model otherwise.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/23-subagent-background.ts
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type AssistantMessage, type FauxResponseStep, Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import {
	AssistantEntry,
	ConversationConfig,
	type ConversationId,
	createRegistry,
	defineDoc,
	defineTask,
	type EntryId,
	Harness,
	LiveDoc,
	MemoryStorage,
	type TaskId,
	type ToolRegistration,
} from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;

// ─── Product code ────────────────────────────────────────────────────────────

type Subagent = { conversationId: ConversationId; supervisor: TaskId<{ answer: EntryId }>; requestId: string };

/** The parent's subagents by name. A fork starts without them. */
const Subagents = defineDoc<{ agents: Record<string, Subagent> }>({
	kind: "app.subagents",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ agents: {} }),
});

/** Background supervisor: submits the subagent's task and waits for its answer. */
const Supervisor = defineTask<
	{ parent: ConversationId; name: string; task: string },
	{ phase: "run" },
	{ answer: EntryId }
>({
	name: "app.subagent-supervisor",
	version: 1,
	initial: () => ({ phase: "run" }),
	phases: {
		run: async (supervisor, runtime, taskContext) => {
			const { parent, name, task } = supervisor.input;
			const agent = (await runtime.snapshot(Subagents, parent, taskContext))!.agents[name]!;
			const child = (await runtime.conversation(agent.conversationId, taskContext))!;
			// After a restart, the same request ID returns the submission admitted before the crash.
			const submission = await child.submit(
				{ type: "input", content: task, requestId: agent.requestId },
				taskContext,
			);
			const settled = await submission.wait(taskContext);
			if (settled.status !== "done" || settled.type !== "input") throw new Error(`Subagent ${name} failed`);
			await runtime.commit(
				() => ({ status: "terminal", outcome: { status: "completed", result: { answer: settled.answer } } }),
				taskContext,
			);
		},
	},
	abort: (_supervisor, runtime, taskContext) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext),
});

const spawnSubagent: ToolRegistration = {
	name: "spawn_subagent",
	description: "Start a named subagent that works on a task in the background.",
	parameters: Type.Object({ name: Type.String(), task: Type.String() }),
	// Safe to rerun after a crash: the name registry deduplicates the spawn.
	replay: "safe",
	execute: async (args, api, callContext) => {
		const { name, task } = args as { name: string; task: string };
		const parentConfig = await api.snapshot(ConversationConfig, api.conversationId, callContext);
		const conversationId = await api.commit(async (tx) => {
			const agents = (await tx.doc(Subagents, api.conversationId)).agents;
			if (Object.hasOwn(agents, name)) return agents[name]!.conversationId;
			const supervisor = await tx.createTask(
				Supervisor,
				{ parent: api.conversationId, name, task },
				{ background: true },
			);
			const child = await tx.createConversation({ ownership: { kind: "task", taskId: supervisor } });
			const config = await tx.doc(ConversationConfig, child.id);
			if (parentConfig?.model !== undefined) config.model = { ...parentConfig.model };
			config.activeTools = [];
			agents[name] = { conversationId: child.id, supervisor, requestId: `subagent:${name}` };
			return child.id;
		}, callContext);
		return { content: [{ type: "text", text: `Started subagent ${name}.` }], details: { conversationId } };
	},
};

// ─── Host setup ─────────────────────────────────────────────────────────────

const models = createModels();
let model = { provider: "openai", modelId: "gpt-6-sol" };
if (process.env.OPENAI_API_KEY !== undefined) {
	models.setProvider(openaiProvider());
} else {
	// Parent and child requests interleave, so one router answers each by what it asks.
	const faux = fauxProvider();
	models.setProvider(faux.provider);
	model = { provider: "faux", modelId: "faux-1" };
	const route: FauxResponseStep = (request) => {
		const last = request.messages.at(-1)!;
		if (last.role === "toolResult") return fauxAssistantMessage([fauxText("The reader subagent is on it.")]);
		if (JSON.stringify(last).includes("Summarize the plot")) {
			// The subagent takes a while, so the parent answers first.
			return new Promise((resolve) =>
				setTimeout(() => resolve(fauxAssistantMessage([fauxText("A whale, a captain, an obsession.")])), 300),
			);
		}
		const call = fauxToolCall("spawn_subagent", { name: "reader", task: "Summarize the plot of Moby Dick." });
		return fauxAssistantMessage([call], { stopReason: "toolUse" });
	};
	faux.setResponses([route, route, route]);
}
const registry = createRegistry();
registry.tasks.add(Supervisor);
registry.tools.add(spawnSubagent);
const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
const root = await harness.root(context);
await root.setModel(model, context);

// ─── A run that starts a subagent, and a UI listing subagents ───────────────

const answerText = async (id: EntryId, callContext: Context): Promise<string> => {
	const entry = await harness.commit((tx) => tx.entry(AssistantEntry, id), callContext);
	return (entry?.model?.[0] as AssistantMessage).content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
};
const listSubagents = async (): Promise<void> => {
	const agents = (await harness.snapshot(Subagents, root.id, context))?.agents ?? {};
	for (const [name, agent] of Object.entries(agents)) {
		const active = (await harness.snapshot(LiveDoc, agent.conversationId, context))?.run !== undefined;
		console.log(`  ${name}: conversation ${agent.conversationId}, ${active ? "working" : "idle"}`);
	}
};

const settled = await (
	await root.submit(
		{ type: "input", content: "Start a subagent named reader that summarizes the plot of Moby Dick." },
		context,
	)
).wait(context);
if (settled.status === "done" && settled.type === "input")
	console.log("parent:", await answerText(settled.answer, context));
// The parent's idle wait stops at the background supervisor.
await root.waitForIdle(context);
console.log("subagents:");
await listSubagents();

// Wait for the subagent's supervisor, then read the answer it recorded.
const reader = (await harness.snapshot(Subagents, root.id, context))!.agents.reader!;
const done = await harness.waitForTask(reader.supervisor, context);
if (done.state.outcome.status === "completed") {
	console.log("reader:", await answerText(done.state.outcome.result.answer, context));
}
console.log("subagents:");
await listSubagents();
await harness.close(context);
