// Page and worker telemetry delivery: one batch at a time, best-effort failures, and releasing queued work on stop.

import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { hostKind } from "../../src/contracts/index.ts";
import type { Principal } from "../../src/data/index.ts";
import { createHost } from "../../src/host/index.ts";
import { memoryLinkPair } from "../../src/link/index.ts";
import {
	sendPageTelemetry,
	sendWorkerTelemetry,
	type TelemetryBatch,
	TelemetryRecorder,
	telemetryIngestFacet,
} from "../../src/telemetry-ingest/index.ts";
import { testCodec, transported } from "../support.ts";

const Server = hostKind("server");

/** A server with the ingest facet (its batches collected) and a client of `principal` recording to `recorder`. */
async function sending(principal: Principal, scope: (incarnation: string) => string) {
	const batches: TelemetryBatch[] = [];
	const server = createHost({ address: Server(), principal: { kind: "server" }, onError: () => {} });
	const facet = telemetryIngestFacet({
		target: {
			ingest: (batch) => {
				batches.push(batch);
				return batch.spans.length;
			},
		},
		admit: () => true,
		workerHost: (who) => (who.kind === "worker" ? "project|p1" : undefined),
		principalAttributes: () => ({}),
	});
	await server.load([{ name: "chord.telemetry", facet }], context);
	let incarnation = "";
	const recorder = new TelemetryRecorder(() => scope(incarnation), 100);
	const client = createHost({ telemetry: recorder, onError: () => {} });
	incarnation = client.incarnation;
	await client.load([], context);
	const connect = () => {
		const [a, b] = memoryLinkPair();
		server.accept(a, { principal, codec: testCodec() }, context);
		client.connect(b, { principal: { kind: "server" }, codec: testCodec() }, context);
		return a;
	};
	return { batches, recorder, server, client, connect };
}

describe("a page's sender", () => {
	it("sends its spans without metrics once bound; until then they wait in the recorder", async () => {
		const { batches, recorder, client, connect } = await sending({ kind: "owner" }, (inc) => `browser:${inc}`);
		const sender = sendPageTelemetry(client, recorder, context);
		await recorder.startSpan({ name: "page.click" }, () => {});
		recorder.metrics.counter("clicks").add(1);
		await sender.send(true);
		expect(batches).toEqual([]);
		connect();
		await transported();
		await sender.send(true);
		// The sender's own hold is shared work: a `chord.hold` root on the page's adapter, sent with the rest.
		expect(batches.map(({ spans, metrics }) => [spans.map(({ name }) => name), metrics])).toEqual([
			[["page.click", "chord.hold"], []],
		]);
		expect(recorder.queuedSpans).toBe(0);
		// Nothing waits: no call.
		await sender.send(true);
		expect(batches).toHaveLength(1);
		sender.stop();
	});

	it("gives a refused batch up", async () => {
		// Ids the server refuses: not under the page's prefix.
		const { batches, recorder, client, connect } = await sending({ kind: "owner" }, () => "elsewhere");
		connect();
		const sender = sendPageTelemetry(client, recorder, context);
		await transported();
		await recorder.startSpan({ name: "page.click" }, () => {});
		await sender.send(false);
		expect(batches.map(({ spans }) => spans)).toEqual([[]]);
		expect(recorder.queuedSpans).toBe(0);
	});

	it("gives up a batch whose call fails, and goes on sending", async () => {
		const { batches, recorder, client, connect } = await sending({ kind: "owner" }, (inc) => `browser:${inc}`);
		connect();
		const sender = sendPageTelemetry(client, recorder, context);
		await transported();
		// Over the page schema's 256 characters: the server refuses the call (`invalid/args`).
		await recorder.startSpan({ name: "page.long", attributes: { note: "x".repeat(257) } }, () => {});
		await sender.send(false);
		expect(batches).toEqual([]);
		expect(recorder.queuedSpans).toBe(0);
		await recorder.startSpan({ name: "page.click" }, () => {});
		await sender.send(false);
		expect(batches.map(({ spans }) => spans.map(({ name }) => name))).toEqual([["page.click"]]);
	});
});

describe("a worker's sender", () => {
	it("sends spans and metrics to the worker variant", async () => {
		const { batches, recorder, client, connect } = await sending({ kind: "worker" }, () => "w");
		connect();
		const sender = sendWorkerTelemetry(client, recorder, context);
		await transported();
		await recorder.startSpan({ name: "worker.job" }, () => {});
		recorder.metrics.counter("runs").add(2);
		await sender.send(true);
		const [batch] = batches;
		expect(batch!.spans.map(({ name }) => name)).toEqual(["chord.hold", "worker.job"]);
		expect(batch!.metrics.find(({ name }) => name === "runs")?.sum).toBe(2);
	});

	it("sends one batch at a time: a send made while one is in flight runs after it", async () => {
		const { batches, recorder, client, connect } = await sending({ kind: "worker" }, () => "w");
		const link = connect();
		const sender = sendWorkerTelemetry(client, recorder, context);
		await transported();
		const replies = Promise.withResolvers<void>();
		const send = link.send.bind(link);
		const paused = vi.spyOn(link, "send").mockImplementation((message) => {
			void replies.promise.then(() => send(message));
		});
		const pending: Promise<void>[] = [];
		try {
			await recorder.startSpan({ name: "worker.first" }, () => {});
			pending.push(sender.send(false));
			await transported();
			expect(batches.map(({ spans }) => spans.map(({ name }) => name))).toEqual([["chord.hold", "worker.first"]]);
			await recorder.startSpan({ name: "worker.second" }, () => {});
			pending.push(sender.send(false));
			await transported();
			expect(batches).toHaveLength(1);
		} finally {
			replies.resolve();
			paused.mockRestore();
			await Promise.all(pending);
			sender.stop();
		}
		expect(batches.map(({ spans }) => spans.map(({ name }) => name))).toEqual([
			["chord.hold", "worker.first"],
			["worker.second"],
		]);
	});

	it("stops queued sends and releases the server's object", async () => {
		const { batches, recorder, server, client, connect } = await sending({ kind: "worker" }, () => "w");
		connect();
		const sender = sendWorkerTelemetry(client, recorder, context);
		await transported();
		const references = server.activity.value.references;
		// A worker's final send may queue behind its interval send during shutdown.
		await recorder.startSpan({ name: "worker.job" }, () => {});
		const answering = sender.send(false);
		await Promise.resolve();
		recorder.metrics.counter("late").add(1);
		const last = sender.send(true);
		sender.stop();
		// Neither rejects: a worker sends with `void`, and an unhandled rejection ends its process.
		await Promise.all([answering, last]);
		await transported();
		expect(batches.some(({ metrics }) => metrics.some(({ name }) => name === "late"))).toBe(false);
		expect(server.activity.value.references).toBe(references - 1);
	});
});
