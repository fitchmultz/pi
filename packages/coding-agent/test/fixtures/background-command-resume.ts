import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "../../src/core/session-manager.ts";
import backgroundCommand from "../../src/extensions/background-command/index.ts";
import { createHarness } from "../suite/harness.ts";

const h = await createHarness({
	sessionManager: SessionManager.open(process.argv[2]),
	extensionFactories: [backgroundCommand],
	settings: { compaction: { enabled: false } },
});
h.setResponses([fauxAssistantMessage("Completion consumed")]);
await h.session.bindExtensions({ mode: "rpc" });
console.log("ready");
await delay(2500);
await h.session.waitForIdle();
console.log(JSON.stringify({ calls: h.faux.state.callCount }));
await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
h.cleanup();
