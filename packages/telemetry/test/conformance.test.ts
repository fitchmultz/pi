import { describe, expect, it } from "vitest";
import { InMemoryTelemetryContext, type SpanAttributes } from "../src/index.ts";
import { createTelemetryAdapterConformance, type TelemetryAdapterFixture } from "../src/testing/index.ts";

const conformance = createTelemetryAdapterConformance(() => {
	const context = new InMemoryTelemetryContext();
	return Promise.resolve<TelemetryAdapterFixture>({
		context,
		getSpans: () => Promise.resolve(context.getSpans()),
		[Symbol.asyncDispose]: () => Promise.resolve(),
	});
});

describe("InMemoryTelemetryContext conformance", () => {
	for (const group of new Set(conformance.map((testCase) => testCase.group))) {
		describe(group, () => {
			for (const testCase of conformance.filter((candidate) => candidate.group === group)) {
				it(testCase.name, () => testCase.run());
			}
		});
	}

	it("returns detached snapshots without exposing mutable recording state", async () => {
		const context = new InMemoryTelemetryContext();
		const tags = ["initial"];
		const updates = ["updated"];
		const eventTags = ["event"];
		let openSettled: boolean | undefined;
		let openEndSequence: number | undefined;
		await context.startSpan({ name: "snapshot", attributes: { tags } }, (span) => {
			span.setAttributes({ updates });
			span.addEvent("event", { value: 1, tags: eventTags });
			tags[0] = "mutated input";
			updates[0] = "mutated update";
			eventTags[0] = "mutated event";
			span.setAttributes({ value: 2 });
			const [open] = context.getSpans();
			openSettled = open?.settled;
			openEndSequence = open?.endSequence;
		});

		expect(openSettled).toBe(false);
		expect(openEndSequence).toBeUndefined();
		const [first] = context.getSpans();
		expect(first?.settled).toBe(true);
		expect(first?.endSequence).toBe(1);
		(first?.attributes.tags as string[])[0] = "mutated snapshot";
		(first?.attributes as SpanAttributes).updates = ["mutated"];
		(first?.events[0]?.attributes.tags as string[])[0] = "mutated snapshot";
		(first?.events[0]?.attributes as SpanAttributes).value = 2;

		const [second] = context.getSpans();
		expect(second?.attributes).toEqual({ tags: ["initial"], updates: ["updated"], value: 2 });
		expect(second?.events).toEqual([{ name: "event", attributes: { value: 1, tags: ["event"] } }]);
	});
});
