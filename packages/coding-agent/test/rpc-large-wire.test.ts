import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

test("native producer and RpcClient deliver a >512 MiB complete event without a whole-record string", async () => {
	const client = new RpcClient({
		cliPath: fileURLToPath(new URL("./fixtures/rpc-large-wire.mjs", import.meta.url)),
		env: { NODE_OPTIONS: "--max-old-space-size=96" },
	});
	await client.start();
	try {
		const received = client.collectEvents(90000);
		await client.setSessionName("large");
		const events = await received;
		expect(events.map((event) => event.type)).toEqual(["agent_end", "agent_settled"]);
		const end = events[0];
		if (end.type !== "agent_end") throw new Error("Missing aggregate event");
		expect(end.messages).toHaveLength(520);
		const expectedText = "x".repeat(1024 * 1024);
		expect(end.messages.every((message) => message.role === "user" && message.content === expectedText)).toBe(true);
		await vi.waitFor(() => expect(client.getStderr()).toContain("WIRE_RECEIPT "));
		const receiptLine = client
			.getStderr()
			.split("\n")
			.find((line) => line.startsWith("WIRE_RECEIPT "));
		expect(receiptLine).toBeDefined();
		const receipt = JSON.parse(receiptLine!.slice("WIRE_RECEIPT ".length)) as {
			bytes: number;
			maximumChunk: number;
			heap: number;
		};
		expect(receipt.bytes).toBeGreaterThan(512 * 1024 * 1024);
		expect(receipt.maximumChunk).toBeLessThanOrEqual(65536);
		expect(receipt.heap).toBeLessThan(96 * 1024 * 1024);
	} finally {
		await client.stop();
	}
}, 120000);
