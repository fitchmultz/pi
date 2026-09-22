import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

const clients: RpcClient[] = [];
const tempDirs: string[] = [];

async function startClient(handleCommand: string): Promise<RpcClient> {
	const dir = mkdtempSync(join(tmpdir(), "pi-rpc-client-contract-"));
	tempDirs.push(dir);
	const cliPath = join(dir, "child.mjs");
	writeFileSync(
		cliPath,
		`
const output = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let newline;
	while ((newline = buffer.indexOf("\\n")) !== -1) {
		const command = JSON.parse(buffer.slice(0, newline));
		buffer = buffer.slice(newline + 1);
		const respond = (data) => output({ type: "response", id: command.id, command: command.type, success: true, ...data });
		${handleCommand}
	}
});
`,
	);
	const client = new RpcClient({ cliPath });
	clients.push(client);
	await client.start();
	return client;
}

afterEach(async () => {
	vi.clearAllTimers();
	vi.useRealTimers();
	for (const client of clients.splice(0)) await client.stop();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("RpcClient response contract", () => {
	it.each([
		["prompt", (client: RpcClient) => client.prompt("rejected")],
		["setter", (client: RpcClient) => client.setSessionName("")],
		["data getter", (client: RpcClient) => client.getEntries("missing")],
	] as const)("rejects a negative acknowledgement from a %s", async (_name, request) => {
		const client = await startClient('respond({ success: false, error: "host rejected this request" });');
		await expect(request(client)).rejects.toThrow("host rejected this request");
	});

	it("waits successfully when already idle without needing a settlement event", async () => {
		const client = await startClient("respond();");
		await expect(client.waitForIdle(100)).resolves.toBeUndefined();
	});

	it("waits successfully after a settlement has already been received", async () => {
		const client = await startClient(`
			if (command.type === "prompt") {
				output({ type: "agent_start" });
				output({ type: "agent_settled" });
			}
			respond();
		`);
		const events = await client.promptAndWait("finish", undefined, 100);
		expect(events.map((event) => event.type)).toEqual(["agent_start", "agent_settled"]);
		await expect(client.waitForIdle(100)).resolves.toBeUndefined();
	});

	it("promptAndWait rejects with the host error and releases its event listener and timer", async () => {
		const client = await startClient('respond({ success: false, error: "already processing" });');
		vi.useFakeTimers();
		await expect(client.promptAndWait("rejected", undefined, 100)).rejects.toThrow("already processing");
		expect(Reflect.get(client, "eventListeners")).toEqual([]);
		expect(Reflect.get(client, "pendingRequests").size).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("promptAndWait completes for handled input that starts no model run", async () => {
		const client = await startClient("respond();");
		await expect(client.promptAndWait("handled", undefined, 100)).resolves.toEqual([]);
		expect(Reflect.get(client, "eventListeners")).toEqual([]);
	});

	it("discards a timed-out idle response without publishing it as an agent event", async () => {
		const client = await startClient(`
			if (command.type === "wait_for_idle") process.idleResponse = respond;
			else { process.idleResponse(); respond(); }
		`);
		const listener = vi.fn();
		const unsubscribe = client.onEvent(listener);
		vi.useFakeTimers();
		const waiting = expect(client.waitForIdle(100)).rejects.toThrow("Timeout waiting for agent to become idle");
		await vi.advanceTimersByTimeAsync(100);
		await waiting;
		expect(Reflect.get(client, "pendingRequests").size).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
		await client.setSessionName("release late response");
		expect(listener).not.toHaveBeenCalled();
		unsubscribe();
	});

	it("uses the idle timeout rather than the normal 30-second request timeout", async () => {
		const client = await startClient(`
			if (command.type === "wait_for_idle") process.idleResponse = respond;
			else { process.idleResponse(); respond(); }
		`);
		vi.useFakeTimers();
		let finished = false;
		const waiting = client.waitForIdle().then(() => {
			finished = true;
		});
		await vi.advanceTimersByTimeAsync(30001);
		expect(finished).toBe(false);
		await client.setSessionName("release");
		await waiting;
		expect(Reflect.get(client, "pendingRequests").size).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("bounds promptAndWait admission by its timeout and cleans up", async () => {
		const client = await startClient("");
		vi.useFakeTimers();
		const waiting = expect(client.promptAndWait("held", undefined, 100)).rejects.toThrow(
			"Timeout waiting for response to prompt",
		);
		await vi.advanceTimersByTimeAsync(100);
		await waiting;
		expect(Reflect.get(client, "pendingRequests").size).toBe(0);
		expect(Reflect.get(client, "eventListeners")).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each(["process", "stdin"] as const)("rejects an idle wait and cleans up after a %s error", async (source) => {
		const client = await startClient("");
		vi.useFakeTimers();
		const waiting = expect(client.waitForIdle()).rejects.toThrow("broken transport");
		const child: ChildProcess = Reflect.get(client, "process");
		(source === "process" ? child : child.stdin!).emit("error", new Error("broken transport"));
		await waiting;
		expect(Reflect.get(client, "pendingRequests").size).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("rejects an idle wait when the process exits", async () => {
		const client = await startClient('if (command.type === "set_session_name") process.exit(43);');
		const waiting = expect(client.waitForIdle(200)).rejects.toThrow("Agent process exited (code=43 signal=null)");
		await expect(client.setSessionName("exit")).rejects.toThrow("Agent process exited");
		await waiting;
		expect(Reflect.get(client, "pendingRequests").size).toBe(0);
	});
});
