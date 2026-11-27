// Cache warming in the session worker: a Durable extension whose `afterResponse` hook starts warming each
// conversation's last request (`./warmer.ts`), bound to the Harness, the settings and the worker's liveness.
import { getCacheWarmingMaxIdleAgeMs, type Message, type Usage, usesGoogleImplicitCache } from "@earendil-works/pi-ai";
import { defineExtension, GenerationTask, hook, LiveDoc, UsageDoc, type UsageState } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, defineFacet, local } from "@p2/app/v1";
import { ExtensionSwitches } from "@p2/app/v1/node";
import { Extensions, harnessOf, isTopLevel, workerOf } from "@p2/app/v1/worker";
import { WorkerModels } from "../models/contract.ts";
import { ConversationWarmers, type ReplayGeneration } from "./warmer.ts";

/**
 * Keeps the prompt cache entries of the session's conversations warm (`./warmer.ts`): one per worker, started with
 * it; a reload or a stop closes its timers and in-flight refreshes, and the next real request starts warming again.
 */
const CacheWarmingRuntime = local("p2.cache-warming-runtime", { version: 1, params: {}, members: {} });

export default defineFacet((host) => {
	host.serve(CacheWarmingRuntime, (_params, self) => {
		const harness = harnessOf(self);
		const worker = workerOf(self);
		const settings = self.get(WorkerModels, {});
		const durable = () => harness().durable;
		const context = BACKGROUND_CONTEXT;
		// Timers and in-flight refreshes live in this native: a reload or the worker's stop ends them, and the next
		// response starts warming again. Nothing of it is durable: the requests it repeats are not stored.
		const warmers = self.open(
			async () =>
				new ConversationWarmers({
					mode: () => settings.settings.value.cacheWarming ?? "idle",
					phase: async (conversationId, request, generation) => {
						const session = durable();
						const conversation = await session.conversation(conversationId, context);
						if (conversation === undefined) return undefined;
						const { model } = await conversation.agent(context);
						if (model?.provider !== request.model.provider || model.modelId !== request.model.id)
							return undefined;
						// A reset, compaction or edit replaced what the request sent: the next request starts differently.
						const current = (await conversation.context(context)).messages;
						if (!startsWith(current, request.messages)) return undefined;
						// Only the main conversation and its `/tree` branches can warm while idle, and never for Google.
						const idleEligible =
							getCacheWarmingMaxIdleAgeMs(request.model) > 0 && (await isTopLevel(session, conversationId, context));
						// Read the run last: it can settle while we load the agent and context.
						const live = await session.snapshot(LiveDoc, conversationId, context);
						if (generation !== undefined && live?.run?.taskId !== generation.taskId) return undefined;
						// afterResponse precedes the tool-round commit. Its own finished generation still owns the run.
						if (live?.generation !== undefined && generation?.next !== "tool-round") return undefined;
						return live?.run !== undefined ? "streaming" : idleEligible ? "idle" : undefined;
					},
					record: async (conversationId, { provider, model, usage }) => {
						await durable().commit(async (tx) => {
							const { models } = await tx.doc(UsageDoc, conversationId);
							addUsage(models, `${provider}/${model}`, usage);
						}, context);
					},
					keepAlive: (delta) => worker().liveness.add("cacheWarming", delta),
				}),
			(opened) => opened.close(),
		);
		const extension = defineExtension({
			name: "cache-warming",
			hooks: [
				hook(GenerationTask, {
					afterResponse: (message, api) => {
						const request = harness().requestOf(message);
						if (request === undefined) return;
						const generation: ReplayGeneration | undefined = usesGoogleImplicitCache(request.model.api)
							? {
									taskId: api.taskId,
									next:
										message.stopReason === "toolUse" &&
										message.content.some((item) => item.type === "toolCall")
											? "tool-round"
											: "answer",
								}
							: undefined;
						warmers.value.start(api.conversationId, message, request, api.models, generation);
					},
				}),
			],
		});
		// `cacheWarming: "off"` uninstalls the hook live; runs already warming stop at their next refresh.
		self.contribute(
			ExtensionSwitches,
			self.derive([settings.settings], ([value]) => ({ [extension.name]: value.cacheWarming !== "off" })),
		);
		self.contribute(Extensions, { [extension.name]: extension });
		return {};
	});
});

/** Whether `current` starts with `sent`, compared by role and timestamp. */
function startsWith(current: readonly Message[], sent: readonly Message[]): boolean {
	return (
		current.length >= sent.length &&
		sent.every(
			(message, index) => current[index]!.role === message.role && current[index]!.timestamp === message.timestamp,
		)
	);
}

/** Adds `usage` to `totals[key]` in a `pi.usage` draft, as Durable's own usage recording does. */
function addUsage(totals: UsageState["models"], key: string, usage: Usage): void {
	// Own keys only, as Durable looks them up.
	const total = Object.hasOwn(totals, key) ? totals[key] : undefined;
	if (total === undefined) {
		// Providers may leave optional counters `undefined`; drafts take strict JSON, which the round trip leaves.
		totals[key] = JSON.parse(JSON.stringify(usage)) as UsageState["models"][string];
		return;
	}
	total.input += usage.input;
	total.output += usage.output;
	total.cacheRead += usage.cacheRead;
	total.cacheWrite += usage.cacheWrite;
	total.totalTokens += usage.totalTokens;
	if (usage.cacheWrite1h !== undefined) total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h;
	if (usage.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
	total.cost.input += usage.cost.input;
	total.cost.output += usage.cost.output;
	total.cost.cacheRead += usage.cost.cacheRead;
	total.cost.cacheWrite += usage.cost.cacheWrite;
	total.cost.total += usage.cost.total;
}
