// What voice mode heard and has yet to deliver: each final transcript waits here until the conversation accepted it.
// Sends go one at a time in the order spoken; a send that fails because the link is down (the reference is gone, a
// ping timeout) is kept and tried again, through whatever reference the conversation has by then. Each transcript keeps
// its request ID across attempts, so one the server already admitted is not placed twice. Turning voice mode off
// (`clear`) ends its delivery: what waits is dropped, and a stop or send already in flight completes without sending
// anything more of it.
import { isChordError } from "@p2/app/v1";
import { DEFAULT_AGENT_NAME, mentionsAgent, spokenMention } from "../chat-mode/contract.ts";

/** Where transcripts go: the conversation's current reference. */
export type TranscriptTarget = {
	send(text: string, requestId: string): Promise<unknown>;
	/** Aborts the run; inputs still queued are withdrawn, and the caller's own come back as text. */
	stop(): Promise<{ readonly restored: readonly string[] }>;
};

export type TranscriptOptions = {
	/** The conversation's reference now; undefined while there is none. */
	target: () => TranscriptTarget | undefined;
	/** Whether the agent works now (its run is stopped before each new message that interrupts it). */
	busy: () => boolean;
	log: (message: string) => void;
	/** A transcript is lost (refused, or too many waiting). */
	onError: (message: string) => void;
	onChange: () => void;
	/** At most this many wait; beyond, the oldest not being sent is dropped. */
	limit?: number;
	/** After a failed attempt, the next one (unless `flush()` comes first, as after a new reference). */
	retryMs?: number;
	/** How long withdrawn messages wait for the next one before they are sent alone (`carry`). */
	carryMs?: number;
	/** A send that has not settled by then counts as waiting for the link (it still completes or fails). */
	slowMs?: number;
};

type Pending = { text: string; requestId: string; attempted: boolean; interrupts: boolean };

/**
 * What one voice-mode lifetime (until `clear()`) has yet to deliver: its transcripts, the messages its stops withdrew,
 * their timers, and whether the link holds them back. Work of an ended one may still complete (a send already made is
 * not taken back), but sends nothing more of it and leaves the next one's alone.
 */
class Delivery {
	readonly items: Pending[] = [];
	/** This person's messages a stop withdrew: they go with the next transcript (`carry`). */
	readonly carried: string[] = [];
	carryTimer: ReturnType<typeof setTimeout> | undefined;
	/** The next attempt after a failed one. */
	retry: ReturnType<typeof setTimeout> | undefined;
	waiting = false;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * What a transcript becomes as a message. With chat mode on, people talk with each other and Pi answers only when
 * addressed: "Pi, …" becomes an `@pi` mention, and only a mention interrupts Pi (its speech and its run). Without chat
 * mode every message is for Pi.
 */
export function voiceMessage(
	text: string,
	chatMode: boolean,
	name = DEFAULT_AGENT_NAME,
): { text: string; interrupts: boolean } {
	if (!chatMode) return { text, interrupts: true };
	const message = spokenMention(text, name);
	return { text: message, interrupts: mentionsAgent(message, name) };
}

/** A failure of the link rather than of the message: worth another attempt. */
export function isTransient(error: unknown): boolean {
	if (!isChordError(error)) return true;
	return ["unavailable", "gone", "released", "not_ready", "superseded", "aborted"].includes(error.code);
}

export class PendingTranscripts {
	readonly #options: TranscriptOptions;
	#delivery = new Delivery();
	/** The one flush at a time, for all lifetimes: each send starts after the one before it settled. */
	#flushing: Promise<void> | undefined;
	#again = false;
	/**
	 * A stop in flight (`stopping`): sends wait for it, so a message is not withdrawn by the stop meant for its run. It
	 * outlasts `clear()`: a new transcript sent meanwhile would be withdrawn by the old stop, and dropped with the rest of
	 * what it withdrew.
	 */
	#stop: Promise<void> | undefined;

	constructor(options: TranscriptOptions) {
		this.#options = options;
	}

	get size(): number {
		return this.#delivery.items.length;
	}

	/** Transcripts held back by the link (none while the link works and sends simply take a moment). */
	get waiting(): number {
		const { items, waiting } = this.#delivery;
		return waiting ? items.length : 0;
	}

	/**
	 * Messages of this person that a stop withdrew (a barge-in's): they go with the next message, or on their own after
	 * a few seconds without one.
	 */
	carry(texts: readonly string[]): void {
		const kept = texts.filter((text) => text.trim());
		if (kept.length === 0) return;
		const delivery = this.#delivery;
		delivery.carried.push(...kept);
		clearTimeout(delivery.carryTimer);
		delivery.carryTimer = setTimeout(() => {
			const alone = delivery.carried.splice(0);
			if (alone.length > 0) this.push(alone.join("\n\n"), false);
		}, this.#options.carryMs ?? 10_000);
	}

	/**
	 * The run is being stopped (the speaker's words interrupted it): sends wait until the stop settled, and this
	 * person's messages it withdrew go with the next message.
	 */
	stopping(stop: Promise<{ readonly restored: readonly string[] }>): void {
		const delivery = this.#delivery;
		const settled = stop
			.then(({ restored }) => {
				// Voice mode went off meanwhile: what the stop withdrew is dropped with what waited.
				const kept = delivery === this.#delivery;
				if (restored.length > 0)
					this.#options.log(
						`stopped; ${restored.length} queued message(s) ${kept ? "kept" : "dropped (voice mode off)"}`,
					);
				if (kept) this.carry(restored);
			})
			.catch((error: unknown) => this.#options.log(`stop failed: ${messageOf(error)}`))
			.finally(() => {
				if (this.#stop === settled) this.#stop = undefined;
			});
		this.#stop = settled;
	}

	/** Queues `text`; one that `interrupts` stops a busy run before it is sent (`voiceMessage`). */
	push(text: string, interrupts = true): void {
		const { items, carried, carryTimer } = this.#delivery;
		if (carried.length > 0) {
			clearTimeout(carryTimer);
			text = [...carried.splice(0), text].join("\n\n");
		}
		const limit = this.#options.limit ?? 10;
		if (items.length >= limit) {
			// The one being sent may already be placed; the next oldest goes.
			const dropAt = items.length > 1 ? 1 : 0;
			items.splice(dropAt, 1);
			this.#options.onError("Too many messages waiting; dropped one");
		}
		items.push({ text, requestId: crypto.randomUUID(), attempted: false, interrupts });
		this.#options.log(`transcript queued (${items.length} waiting)`);
		void this.flush();
	}

	/** Sends what waits, in order; one flush at a time (a call during one makes it go round again). */
	flush(): Promise<void> {
		const delivery = this.#delivery;
		clearTimeout(delivery.retry);
		delivery.retry = undefined;
		if (this.#flushing) {
			this.#again = true;
			return this.#flushing;
		}
		this.#flushing = this.#run().finally(() => {
			this.#flushing = undefined;
			this.#options.onChange();
		});
		return this.#flushing;
	}

	/** Voice mode went off: what waits is dropped, and work in flight sends nothing more of it (`Delivery`). */
	clear(): void {
		const { items, carried, carryTimer, retry } = this.#delivery;
		clearTimeout(retry);
		clearTimeout(carryTimer);
		if (items.length > 0) this.#options.log(`${items.length} transcripts dropped (voice mode off)`);
		items.length = 0;
		carried.length = 0;
		this.#delivery = new Delivery();
	}

	async #run(): Promise<void> {
		const { target, busy, log, onError, onChange } = this.#options;
		do {
			this.#again = false;
			// The current delivery's oldest each time: after `clear()`, the next lifetime's.
			for (let item = this.#delivery.items[0]; item; item = this.#delivery.items[0]) {
				const delivery = this.#delivery;
				// A stop in flight first: a message sent meanwhile would be withdrawn by it.
				if (this.#stop) {
					await this.#stop;
					// Voice mode went off meanwhile: this transcript was dropped.
					if (delivery !== this.#delivery) continue;
				}
				if (!item.attempted && delivery.carried.length > 0) {
					clearTimeout(delivery.carryTimer);
					item.text = [...delivery.carried.splice(0), item.text].join("\n\n");
				}
				const chat = target();
				if (!chat) {
					this.#setWaiting(delivery, true);
					log(`waiting for the conversation (${delivery.items.length} transcripts)`);
					return;
				}
				// As typing and pressing Stop: a message for Pi while it works stops that run first (a retry does not stop
				// again: its first attempt may have been placed).
				const stopFirst = item.interrupts && !item.attempted && busy();
				const retry = item.attempted;
				item.attempted = true;
				log(`send${retry ? " (again)" : ""}${stopFirst ? " (stopping the run first)" : ""}`);
				const slow = setTimeout(() => {
					log("send is slow; waiting for the link");
					this.#setWaiting(delivery, true);
				}, this.#options.slowMs ?? 5000);
				try {
					if (stopFirst) {
						const stopped = await chat.stop().catch((error: unknown) => {
							log(`stop before send failed: ${messageOf(error)}`);
							return undefined;
						});
						// This person's messages still queued were withdrawn by the stop: they go with this one, not lost.
						const restored = stopped?.restored.filter((text) => text.trim()) ?? [];
						// Unless voice mode went off meanwhile: then this one and they are dropped.
						if (delivery !== this.#delivery) {
							log(`stopped; this and ${restored.length} queued message(s) dropped (voice mode off)`);
							continue;
						}
						if (restored.length > 0) {
							item.text = [...restored, item.text].join("\n\n");
							log(`stopped; ${restored.length} queued message(s) of yours go with this one`);
						} else log("stopped");
					}
					await chat.send(item.text, item.requestId);
					const at = delivery.items.indexOf(item);
					if (at >= 0) delivery.items.splice(at, 1);
					this.#setWaiting(delivery, false);
					log(`sent (${delivery.items.length} waiting)`);
				} catch (error) {
					if (isTransient(error)) {
						// Voice mode went off meanwhile: dropped, not tried again.
						if (delivery !== this.#delivery) {
							log(`send failed, dropped (voice mode off): ${messageOf(error)}`);
							continue;
						}
						log(`send failed, kept for another try: ${messageOf(error)}`);
						this.#setWaiting(delivery, true);
						// A new reference arrived meanwhile: try it at once.
						if (this.#again) {
							this.#again = false;
							continue;
						}
						delivery.retry = setTimeout(() => void this.flush(), this.#options.retryMs ?? 3000);
						return;
					}
					const at = delivery.items.indexOf(item);
					if (at >= 0) delivery.items.splice(at, 1);
					onError(`Send failed: ${messageOf(error)}`);
				} finally {
					clearTimeout(slow);
					onChange();
				}
			}
		} while (this.#again);
	}

	#setWaiting(delivery: Delivery, waiting: boolean): void {
		if (delivery.waiting === waiting) return;
		delivery.waiting = waiting;
		this.#options.onChange();
	}
}
