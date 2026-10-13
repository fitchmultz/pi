// One FIFO queue for every observer notification (state events, shape pushes, registry tables, listener
// invocations).
//
// Problem: notifying observers synchronously from inside a write lets a re-entrant write overtake the write being
// published. Example: subscriber A reacts to n = 1 by writing n = 2; subscriber B then sees 2 before 1.
// Solution: a publication first adopts every revision it makes (cells and derivations), then enqueues its
// notifications. Notifications run in enqueue order, so every observer sees revisions in adoption order.
// `holdPublications` defers delivery until a multi-step change (a reload commit) is complete.

const queue: ((() => void) | undefined)[] = [];
let held = 0;
let draining = false;

/** Runs `task` after everything enqueued before it. Tasks must not throw (report instead). */
export function enqueue(task: () => void): void {
	queue.push(task);
	drain();
}

/** Delivers nothing until `fn` returns, then everything it enqueued, in order. */
export function holdPublications<T>(fn: () => T): T {
	held++;
	try {
		return fn();
	} finally {
		held--;
		drain();
	}
}

function drain(): void {
	if (draining || held > 0) return;
	draining = true;
	let consumed = 0;
	try {
		while (consumed < queue.length) {
			const task = queue[consumed]!;
			queue[consumed++] = undefined;
			task();
			// Compact only after enough consumption to keep reentrant chains bounded and copying amortized.
			if (consumed >= 1024 && consumed * 2 >= queue.length) {
				queue.splice(0, consumed);
				consumed = 0;
			}
		}
	} finally {
		if (consumed === queue.length) queue.length = 0;
		else queue.splice(0, consumed);
		draining = false;
	}
}
