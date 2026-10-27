import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { expect, it } from "vitest";

const context = BACKGROUND_CONTEXT;

for (const scenario of ["idle", "busy", "entry data", "boundary", "queue total"] as const) {
	const busy = scenario === "busy" || scenario === "boundary" || scenario === "queue total";
	const name =
		scenario === "boundary"
			? "settles an unstoreable queued input while preserving the answer and advancing valid siblings"
			: scenario === "queue total"
				? "admits individually fitting inbox deltas whose combined content exceeds one SQLite row"
				: `refuses oversized ${scenario} input without admitting it or ending the Session`;
	it(name, async () => {
		await runInDurableObject(env.SESSIONS.get(env.SESSIONS.newUniqueId()), async (_instance, state) => {
			// Exercise the pinned workerd row boundary, not a Native byte limit; verify the raw value fits below.
			const payload = "x".repeat(
				scenario === "queue total" ? 5 * 1024 * 1024 : 8 * 1024 * 1024 - (scenario === "boundary" ? 64 : 0),
			);
			const input =
				scenario === "entry data"
					? { content: "small", entry: { kind: "custom", data: { body: payload } } }
					: { content: payload };
			state.storage.sql.exec("CREATE TABLE input_probe (value TEXT NOT NULL)");
			state.storage.sql.exec(
				"INSERT INTO input_probe VALUES (?)",
				JSON.stringify(scenario === "entry data" ? input.entry?.data : payload),
			);
			state.storage.sql.exec("DELETE FROM input_probe");
			const faux = fauxProvider();
			const started = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			faux.setResponses([
				async (_request, options) => {
					started.resolve();
					if (busy) {
						await new Promise<void>((resolve, reject) => {
							const abort = () => reject(new DOMException("Interrupted", "AbortError"));
							if (options?.signal?.aborted) abort();
							else options?.signal?.addEventListener("abort", abort, { once: true });
							void release.promise.then(resolve, reject);
						});
					}
					return fauxAssistantMessage("answer");
				},
				fauxAssistantMessage("next answer"),
				fauxAssistantMessage("last answer"),
			]);
			const models = createModels();
			models.setProvider(faux.provider);
			const harness = await Harness.open(
				await openDurableObjectSqliteStorage(state.storage, { prefix: "admission_" }),
				{ models, registry: createRegistry(), settings: { followUpMode: "one-at-a-time" } },
				context,
			);
			try {
				const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
				const first = busy ? await root.submit({ type: "input", content: "first" }, context) : undefined;
				if (busy) await started.promise;
				if (scenario === "queue total") {
					const left = await root.submit({ type: "input", ...input }, context);
					const right = await root.submit({ type: "input", ...input }, context);
					expect((await left.status(context)).status).toBe("queued");
					expect((await right.status(context)).status).toBe("queued");
					expect(await left.abort(context)).toBe("aborted");
					expect(await right.abort(context)).toBe("aborted");
					release.resolve();
					expect((await first!.wait(context)).status).toBe("done");
					return;
				}
				if (scenario === "boundary") {
					// This real inbox revision fits; placing its larger entry, including task attribution, does not.
					const blocked = await root.submit({ type: "input", ...input }, context);
					expect((await blocked.status(context)).status).toBe("queued");
					const next = await root.submit({ type: "input", content: "next" }, context);
					const last = await root.submit({ type: "input", content: "last" }, context);
					release.resolve();
					expect((await first!.wait(context)).status).toBe("done");
					expect(await blocked.wait(context)).toMatchObject({ status: "unanswered", reason: "input_too_large" });
					expect((await next.wait(context)).status).toBe("done");
					expect((await last.wait(context)).status).toBe("done");
					expect(faux.state.callCount).toBe(3);
					const entries = await root.entries({}, 20, undefined, context);
					expect(
						entries.items.filter((entry) => entry.kind === "pi.user").map((entry) => entry.model?.[0]?.content),
					).toEqual(["last", "next", "first"]);
					return;
				}
				const view = await root.viewState(context);
				try {
					const before = view.value;
					await expect(
						root.submit({ type: "input", ...input, requestId: "correctable" }, context),
					).rejects.toMatchObject({
						name: "StorageCapacityError",
					});
					expect(view.value).toEqual(before);
					expect(
						await root.commit((tx) => tx.submissionByRequest(root.id, "correctable"), context),
					).toBeUndefined();
					release.resolve();
					if (first !== undefined) expect((await first.wait(context)).status).toBe("done");
					const next = await root.submit(
						{ type: "input", content: "corrected", requestId: "correctable" },
						context,
					);
					expect((await next.wait(context)).status).toBe("done");
					expect(faux.state.callCount).toBe(busy ? 2 : 1);
				} finally {
					view.dispose();
				}
			} finally {
				release.resolve();
				await harness.close(context);
			}
		});
	});
}
