// Resumes the session journal in argv[2] with the background-command extension and prints "ready".
// Once the stop file in argv[3] exists, it finishes one more monitor pass, prints its provider call
// count as JSON and exits.
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "../../src/core/session-manager.ts";
import backgroundCommand from "../../src/extensions/background-command/index.ts";
import { createHarness, createTestUiContext } from "../suite/harness.ts";

const h = await createHarness({
	sessionManager: SessionManager.open(process.argv[2]),
	extensionFactories: [backgroundCommand],
	settings: { compaction: { enabled: false } },
});
h.setResponses([fauxAssistantMessage("Completion consumed")]);
let passes = 0;
await h.session.bindExtensions({
	mode: "rpc",
	uiContext: createTestUiContext({
		// The monitor publishes this status in every pass that holds the delivery lease, right after
		// it lists the job records and before it sends their notice.
		setStatus: (key) => {
			if (key === "background-command") passes++;
		},
	}),
});
console.log("ready");
while (!existsSync(process.argv[3])) {
	await delay(25);
}
// A pass after the stop request has listed every job that finished before it, so this process has
// sent their notice or decided not to. Waiting for the pass, not for a poll interval of wall-clock
// time, also makes a process without the lease outlive its owner and take the lease over.
const passesAtStop = passes;
while (passes === passesAtStop) {
	// The monitor's timer does not keep the process alive; this one does. By the time it fires, the
	// pass has handed its notice to the session.
	await delay(25);
}
await h.session.waitForIdle();
console.log(JSON.stringify({ calls: h.faux.state.callCount }));
await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
h.cleanup();
