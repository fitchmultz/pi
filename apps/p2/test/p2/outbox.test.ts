// The composer's outbox (plugins/chat/outbox.ts): messages are sent in order whenever a sender is connected, retried
// on connection failures with their own request IDs, and put back into the composer when the server refuses them.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Message, Outbox, type Sender } from "../../plugins/chat/outbox.ts";

const message = (id: string): Message => ({
	id,
	text: `text ${id}`,
	files: [],
	whenBusy: "followUp",
	item: { type: "user", key: `outgoing-${id}`, text: `text ${id}`, images: [], files: [] },
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
/** Retries without waiting; accepted messages shown briefly, so no timer outlives a test. */
const fast = { retryDelay: () => 1, shownAtMost: 50 };

/** A sender recording what it sent; `fail` decides per call what goes wrong. */
function sender(fail: (id: string, call: number) => "refuse" | "drop" | undefined = () => undefined) {
	const sent: string[] = [];
	const restored: string[] = [];
	let calls = 0;
	const value: Sender = {
		send: async (outgoing, calling) => {
			calling({ after: 0, idle: true });
			const outcome = fail(outgoing.id, ++calls);
			if (outcome === "refuse") throw new Error("refused");
			if (outcome === "drop") throw new Error("connection lost");
			sent.push(outgoing.id);
			return sent.length;
		},
		refused: (error) => error instanceof Error && error.message === "refused",
		restore: (outgoing) => restored.push(outgoing.id),
	};
	return { value, sent, restored };
}

describe("outbox", () => {
	it("keeps messages until a sender connects, then sends them in order", async () => {
		const outbox = new Outbox(fast);
		outbox.add(message("a"));
		outbox.add(message("b"));
		await tick();
		assert.deepEqual(
			outbox.snapshot().map((entry) => entry.id),
			["a", "b"],
		);
		const { value, sent } = sender();
		outbox.connect(value);
		for (let index = 0; index < 5; index++) await tick();
		assert.deepEqual(sent, ["a", "b"]);
		// Accepted messages stay shown until the transcript shows them.
		assert.deepEqual(
			outbox.snapshot().map(({ delivery }) => (delivery.state === "accepted" ? delivery.submissionId : undefined)),
			[1, 2],
		);
		outbox.settle((entry) => entry.id === "a");
		assert.deepEqual(
			outbox.snapshot().map((entry) => entry.id),
			["b"],
		);
	});

	it("retries a dropped send with the same request ID and puts a refused message back", async () => {
		const outbox = new Outbox(fast);
		const { value, sent, restored } = sender((id, call) =>
			id === "a" && call === 1 ? "drop" : id === "b" ? "refuse" : undefined,
		);
		outbox.connect(value);
		outbox.add(message("a"));
		outbox.add(message("b"));
		outbox.add(message("c"));
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.deepEqual(sent, ["a", "c"], "a retried after the drop, b refused, c after it");
		assert.deepEqual(restored, ["b"]);
	});

	it("keeps where a message's first call went out, for a view opened again", async () => {
		const outbox = new Outbox(fast);
		const view = (send: Sender["send"]): Sender => ({ send, refused: () => false, restore: () => {} });
		outbox.add(message("a"));
		// The first view's upload fails: no call went out, so the server cannot have the message.
		outbox.connect(
			view(async () => {
				throw new Error("upload failed");
			}),
		);
		await tick();
		outbox.connect(undefined);
		assert.deepEqual(outbox.snapshot()[0]?.delivery, { state: "untried" });
		// The next view's call reaches the server, but its answer is lost with the connection.
		outbox.connect(
			view(async (_, calling) => {
				calling({ after: 7, idle: true });
				throw new Error("connection lost");
			}),
		);
		await tick();
		outbox.connect(undefined);
		assert.deepEqual(outbox.snapshot()[0]?.delivery, { state: "tried", start: { after: 7, idle: true } });
		// The view opened again already shows the message's entry and the run it started: its own start would count them.
		outbox.connect(
			view(async (_, calling) => {
				calling({ after: 9, idle: false });
				return 3;
			}),
		);
		await tick();
		assert.deepEqual(outbox.snapshot()[0]?.delivery, {
			state: "accepted",
			start: { after: 7, idle: true },
			submissionId: 3,
		});
	});

	it("gives a message back after failing again and again while connected", async () => {
		const outbox = new Outbox(fast);
		let calls = 0;
		const { value, restored } = sender(() => {
			calls++;
			return "drop";
		});
		outbox.connect(value);
		outbox.add(message("a"));
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(calls, 6, "five retries after the first try");
		assert.deepEqual(restored, ["a"]);
		assert.deepEqual(outbox.snapshot(), []);
	});

	it("lets Stop take back unsent messages, not the one being sent", async () => {
		const outbox = new Outbox(fast);
		let release: () => void = () => {};
		const value: Sender = {
			send: (_, calling) =>
				new Promise((resolve) => {
					calling({ after: 0, idle: true });
					release = () => resolve(1);
				}),
			refused: () => false,
			restore: () => {},
		};
		outbox.connect(value);
		outbox.add(message("a"));
		outbox.add(message("b"));
		await tick();
		assert.deepEqual(
			outbox.takeUnsent().map((entry) => entry.id),
			["b"],
		);
		assert.equal(outbox.take("a"), undefined, "the message being sent stays");
		release();
		await tick();
		assert.deepEqual(
			outbox.snapshot().map((entry) => entry.id),
			["a"],
		);
	});
});
