import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT, withAbortSignal } from "../../../src/harness/context.ts";
import { bashTool } from "../../../src/harness/pico3/bash.ts";
import { Bounded } from "../../../src/harness/pico3/bounded.ts";
import type { ToolApi } from "../../../src/harness/pico3/types.ts";

vi.mock("node:child_process", { spy: true });
afterEach(() => vi.mocked(spawn).mockReset());

function fixture() {
	const child = Object.assign(new EventEmitter(), {
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		kill: vi.fn(() => true),
	});
	vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
	const chunks: string[] = [];
	const api = {
		stream: (chunk: string | Uint8Array) => {
			chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
		},
	} as ToolApi;
	return { child, chunks, api };
}

test("bash decodes interleaved pipes independently and publishes EOF bytes before close", async () => {
	const { child, chunks, api } = fixture();
	const pending = bashTool().execute({ command: "unused" }, api, BACKGROUND_CONTEXT);
	child.stdout.emit("data", Buffer.from([0xe2]));
	child.stderr.emit("data", Buffer.from("warn"));
	child.stdout.emit("data", Buffer.from([0x82, 0xac]));
	child.stderr.emit("data", Buffer.from([0xf0, 0x9f]));
	child.stderr.emit("end");
	expect(chunks.join("")).toBe("warn€�");
	child.emit("close", 0, null);
	expect((await pending).isError).toBe(false);
	child.stdout.emit("data", Buffer.from("late"));
	child.stderr.emit("end");
	expect(chunks.join("")).toBe("warn€�");
	expect(child.stdout.listenerCount("data")).toBe(0);
});

test("generic byte accounting measures decoded shell output, including EOF replacements", async () => {
	const { child, api } = fixture();
	const output = new Bounded(1, 10, "head");
	api.stream = (chunk) => output.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
	const pending = bashTool().execute({ command: "unused" }, api, BACKGROUND_CONTEXT);
	child.stdout.emit("data", Buffer.from("\uFEFF"));
	child.stdout.emit("data", Buffer.from([0xe2]));
	child.emit("close", 0, null);
	await pending;
	// The pipe BOM is consumed; EOF supplies the three UTF-8 bytes of U+FFFD.
	expect(output.total).toBe(3);
	expect(output.droppedBytes).toBe(2);
	expect(output.text()).toBe("");
});

test.each(["process", "stdout", "stderr"])(
	"bash cleans up %s errors and finalizes pending output once",
	async (source) => {
		const { child, chunks, api } = fixture();
		const controller = new AbortController();
		const remove = vi.spyOn(controller.signal, "removeEventListener");
		const pending = bashTool().execute(
			{ command: "unused" },
			api,
			withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
		);
		const rejection = expect(pending).rejects.toThrow("read or spawn failed");
		child.stdout.emit("data", Buffer.from([0xe2]));
		const emitter = source === "process" ? child : source === "stdout" ? child.stdout : child.stderr;
		emitter.emit("error", new Error("read or spawn failed"));
		await rejection;
		expect(chunks.join("")).toBe("�");
		expect(child.kill).toHaveBeenCalledWith("SIGKILL");
		expect(child.stdout.destroyed).toBe(true);
		expect(child.stderr.destroyed).toBe(true);
		expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
		child.stdout.emit("data", Buffer.from("late"));
		child.emit("close", 1, null);
		expect(chunks.join("")).toBe("�");
	},
);

test("bash honors an already-aborted context without dropping received output", async () => {
	const { child, chunks, api } = fixture();
	const pending = bashTool().execute(
		{ command: "unused" },
		api,
		withAbortSignal(AbortSignal.abort(), BACKGROUND_CONTEXT),
	);
	expect(child.kill).toHaveBeenCalledWith("SIGKILL");
	child.stdout.emit("data", Buffer.from([0xe2]));
	child.emit("close", null, "SIGKILL");
	expect((await pending).isError).toBe(true);
	expect(chunks.join("")).toBe("�");
});

test.skipIf(process.platform === "win32")("bash streams decoded strings from a real process", async () => {
	const chunks: Array<string | Uint8Array> = [];
	const api = {
		stream: (chunk: string | Uint8Array) => {
			chunks.push(chunk);
		},
	} as ToolApi;
	const result = await bashTool().execute(
		{ command: "printf '\\342'; sleep 0.05; printf warn >&2; sleep 0.05; printf '\\202\\254'" },
		api,
		BACKGROUND_CONTEXT,
	);
	expect(result.isError).toBe(false);
	expect(chunks.every((chunk) => typeof chunk === "string")).toBe(true);
	expect(chunks.join("")).toBe("warn€");
});
