import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { McpClient, StdioTransport } from "../src/index.ts";

const fixture = fileURLToPath(new URL("./fixtures/stdio-server.mjs", import.meta.url));
const stubborn = fileURLToPath(new URL("./fixtures/stubborn-server.mjs", import.meta.url));
const framing = fileURLToPath(new URL("./fixtures/stdio-framing-server.mjs", import.meta.url));
const exitingParent = fileURLToPath(new URL("./fixtures/exiting-parent-server.mjs", import.meta.url));

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return true;
}

describe("StdioTransport", () => {
	it("preserves fragmented UTF-8, byte limits, CRLF, and recovery after invalid frames", async () => {
		const transport = new StdioTransport({
			command: process.execPath,
			args: [framing, "frames", "128"],
			maxMessageBytes: 128,
		});
		const messages: unknown[] = [];
		const errors: Error[] = [];
		transport.onMessage((message) => messages.push(message));
		transport.onError((error) => errors.push(error));
		const closed = new Promise<void>((resolve) => transport.onClose(resolve));
		try {
			await transport.start();
			await closed;
			expect(messages).toEqual([
				{ jsonrpc: "2.0", id: 1, result: "é😀" },
				{ jsonrpc: "2.0", id: 2, result: true },
				{ jsonrpc: "2.0", id: 3, result: null },
			]);
			expect(errors).toHaveLength(4);
			expect(errors[0]).toBeInstanceOf(SyntaxError);
			expect(errors[1].message).toBe("Invalid JSON-RPC message");
			expect(errors.slice(2).map((error) => error.message)).toEqual([
				"MCP stdio message exceeds 128 bytes",
				"MCP stdio message exceeds 128 bytes",
			]);
		} finally {
			await transport.close();
		}
	});

	it.each(["incomplete", "whitespace"])("reports only nonblank incomplete frames on close: %s", async (mode) => {
		const transport = new StdioTransport({ command: process.execPath, args: [framing, mode] });
		const errors: string[] = [];
		transport.onError((error) => errors.push(error.message));
		const closed = new Promise<void>((resolve) => transport.onClose(resolve));
		try {
			await transport.start();
			await closed;
			expect(errors).toEqual(
				mode === "incomplete" ? ["MCP stdio server closed with an incomplete JSON-RPC message"] : [],
			);
		} finally {
			await transport.close();
		}
	});

	it("connects to a newline-delimited MCP server and captures stderr", async () => {
		const stderr: string[] = [];
		const transport = new StdioTransport({
			command: process.execPath,
			args: [fixture],
			onStderr: (chunk) => stderr.push(chunk),
		});
		const client = new McpClient({ name: "stdio-test", version: "1.0.0" });
		await client.connect(transport);
		expect(await client.listTools()).toEqual([{ name: "echo", inputSchema: { type: "object" } }]);
		expect(await client.callTool("echo", { text: "hello" })).toEqual({
			content: [{ type: "text", text: "hello" }],
		});
		expect(transport.pid).toBeTypeOf("number");
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(stderr.join("")).toContain("stdio fixture ready");
		expect(transport.stderr).toContain("stdio fixture ready");
		await client.close();
		expect(client.connectionState).toBe("closed");
	});

	it.skipIf(process.platform === "win32")(
		"kills a server that ignores shutdown, including its children",
		async () => {
			const transport = new StdioTransport({
				command: process.execPath,
				args: [stubborn],
				closeTimeoutMs: 100,
			});
			const client = new McpClient({ name: "stdio-test", version: "1.0.0" });
			await client.connect(transport);
			let grandchild: number | undefined;
			for (let i = 0; i < 100 && grandchild === undefined; i++) {
				const match = /grandchild (\d+)/.exec(transport.stderr);
				if (match) grandchild = Number(match[1]);
				else await new Promise((resolve) => setTimeout(resolve, 10));
			}
			expect(grandchild).toBeTypeOf("number");

			const startedAt = Date.now();
			await client.close();
			expect(Date.now() - startedAt).toBeLessThan(5_000);
			let alive = true;
			for (let i = 0; i < 100 && alive; i++) {
				try {
					process.kill(grandchild as number, 0);
					await new Promise((resolve) => setTimeout(resolve, 20));
				} catch {
					alive = false;
				}
			}
			expect(alive).toBe(false);
		},
		10_000,
	);

	it.skipIf(process.platform === "win32")(
		"kills children still holding the pipes after the server process exited",
		async () => {
			const transport = new StdioTransport({
				command: process.execPath,
				args: [exitingParent],
				closeTimeoutMs: 100,
			});
			let closeEvents = 0;
			transport.onClose(() => closeEvents++);
			await transport.start();
			const serverPid = transport.pid as number;
			let helper: number | undefined;
			await waitFor(() => {
				const match = /helper (\d+)/.exec(transport.stderr);
				if (match) helper = Number(match[1]);
				return helper !== undefined;
			});
			expect(helper).toBeTypeOf("number");
			expect(await waitFor(() => !isAlive(serverPid))).toBe(true);
			try {
				expect(isAlive(helper as number)).toBe(true);

				await transport.close();
				expect(await waitFor(() => !isAlive(helper as number))).toBe(true);
				expect(closeEvents).toBe(1);
			} finally {
				try {
					process.kill(helper as number, "SIGKILL");
				} catch {}
			}
		},
		10_000,
	);
});
