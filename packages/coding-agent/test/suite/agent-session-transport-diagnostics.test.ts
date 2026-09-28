import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, streamSimple } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness } from "./harness.ts";

it("persists late steering transport diagnostics after the parent message was saved", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-steering-diagnostic-"));
	const manager = SessionManager.create(directory, directory);
	const harness = await createHarness({ sessionManager: manager, tools: [] });
	try {
		const diagnostic = {
			type: "provider_transport_close",
			timestamp: 123,
			details: {
				closeCode: 1000,
				closeInitiator: "remote",
				closeReason: "redacted",
				sinceParentTerminalMs: 3500,
				pendingSteerStatus: "accepted",
			},
		};
		let first = true;
		harness.session.agent.streamFunction = (model, context, options) => {
			const stream = streamSimple(model, context, options);
			if (first) {
				first = false;
				stream.push({ type: "response_end", message: fauxAssistantMessage("parent", { responseId: "parent" }) });
				stream.push({
					type: "steering",
					message: { role: "user", content: "update", timestamp: 2 },
					status: "unknown",
					responseId: "parent",
					diagnostic,
				});
			}
			return stream;
		};
		harness.setResponses([
			fauxAssistantMessage("parent", { responseId: "parent" }),
			fauxAssistantMessage("recovered"),
		]);
		await harness.session.prompt("start");
		const reopened = SessionManager.open(manager.getSessionFile()!);
		const entries = reopened.getEntries();
		const parentIndex = entries.findIndex(
			(entry) =>
				entry.type === "message" && entry.message.role === "assistant" && entry.message.responseId === "parent",
		);
		const closeIndex = entries.findIndex(
			(entry) => entry.type === "custom" && entry.customType === "response-steering",
		);
		expect(parentIndex).toBeGreaterThanOrEqual(0);
		expect(closeIndex).toBeGreaterThan(parentIndex);
		expect(entries[closeIndex]).toMatchObject({ data: { status: "unknown", responseId: "parent", diagnostic } });
	} finally {
		harness.cleanup();
		rmSync(directory, { recursive: true, force: true });
	}
});

it("shares a routing scope across provider continuations but starts fresh on the next prompt", async () => {
	const harness = await createHarness({ tools: [] });
	try {
		const scopes: (object | undefined)[] = [];
		let queued = false;
		harness.setResponses([
			(_context, options) => {
				scopes.push(options?.turnScope);
				if (!queued) {
					queued = true;
					harness.session.agent.steer({ role: "user", content: "update", timestamp: 2 });
				}
				return fauxAssistantMessage("first");
			},
			(_context, options) => {
				scopes.push(options?.turnScope);
				return fauxAssistantMessage("second");
			},
			(_context, options) => {
				scopes.push(options?.turnScope);
				return fauxAssistantMessage("third");
			},
		]);
		await harness.session.prompt("start");
		await harness.session.prompt("new prompt");
		expect(scopes).toHaveLength(3);
		expect(scopes[0]).toBeDefined();
		expect(scopes[1]).toBe(scopes[0]);
		expect(scopes[2]).toBeDefined();
		expect(scopes[2]).not.toBe(scopes[0]);
	} finally {
		harness.cleanup();
	}
});
