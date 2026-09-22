import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { execCommand } from "../src/core/exec.ts";

vi.mock("node:child_process", { spy: true });

afterEach(() => {
	vi.mocked(spawn).mockReset();
	vi.useRealTimers();
});

function fakeChild() {
	const child = Object.assign(new EventEmitter(), {
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		exitCode: null as number | null,
		signalCode: null as string | null,
		killed: false,
		kill: vi.fn(() => {
			child.killed = true;
			return true;
		}),
	});
	vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
	return child;
}

describe("extension command output", () => {
	it("decodes each pipe incrementally, preserves BOMs, and flushes unfinished bytes once", async () => {
		const child = fakeChild();
		const pending = execCommand("unused", [], process.cwd());
		child.stdout.emit("data", Buffer.from([0xef, 0xbb]));
		child.stderr.emit("data", Buffer.from("\uFEFFerr"));
		child.stdout.emit("data", Buffer.from([0xbf, 0xe2]));
		child.stderr.emit("data", Buffer.from([0xe2]));
		child.stdout.emit("data", Buffer.from([0x82, 0xac]));
		child.stdout.emit("data", Buffer.from([0xf0, 0x9f]));
		child.stdout.emit("end");
		child.stderr.emit("end");
		child.emit("close", 0);
		expect(await pending).toEqual({ stdout: "\uFEFF€�", stderr: "\uFEFFerr�", code: 0, killed: false });
	});

	it.each(["stdout", "stderr"] as const)("settles %s read failures and ignores late output", async (source) => {
		const child = fakeChild();
		const pending = execCommand("unused", [], process.cwd());
		child.stdout.emit("data", Buffer.from([0xe2]));
		child[source].emit("error", new Error("read failed"));
		child.emit("close", 0);
		const result = await pending;
		expect(result.code).toBe(1);
		expect(result.stdout).toBe("�");
		expect(child.kill).toHaveBeenCalledWith("SIGKILL");
		expect(child.stdout.destroyed).toBe(true);
		expect(child.stderr.destroyed).toBe(true);
		child.stdout.emit("data", Buffer.from("late"));
		expect(result.stdout).toBe("�");
		expect(child.stdout.listenerCount("data")).toBe(0);
	});

	it("returns the existing error result for a failed spawn and releases its pipes", async () => {
		const child = fakeChild();
		const pending = execCommand("unused", [], process.cwd());
		child.emit("error", new Error("spawn failed"));
		expect(await pending).toEqual({ stdout: "", stderr: "", code: 1, killed: false });
		expect(child.stdout.destroyed).toBe(true);
		expect(child.stderr.destroyed).toBe(true);
	});

	it("escalates based on actual exit and clears both owned timers", async () => {
		vi.useFakeTimers();
		const child = fakeChild();
		const controller = new AbortController();
		const remove = vi.spyOn(controller.signal, "removeEventListener");
		const pending = execCommand("unused", [], process.cwd(), { timeout: 100, signal: controller.signal });
		await vi.advanceTimersByTimeAsync(100);
		expect(child.killed).toBe(true);
		await vi.advanceTimersByTimeAsync(5000);
		expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
		child.emit("close", null);
		expect((await pending).killed).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
		expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
	});

	it("clears the escalation timer when SIGTERM succeeds", async () => {
		vi.useFakeTimers();
		const child = fakeChild();
		const pending = execCommand("unused", [], process.cwd(), { timeout: 100 });
		await vi.advanceTimersByTimeAsync(100);
		child.signalCode = "SIGTERM";
		child.emit("close", null);
		await pending;
		expect(vi.getTimerCount()).toBe(0);
	});

	it("captures complete separate strings from a real child", async () => {
		const result = await execCommand(
			process.execPath,
			["-e", "process.stdout.write('\\uFEFF€');process.stderr.write('\\uFEFF雪')"],
			process.cwd(),
		);
		expect(result).toEqual({ stdout: "\uFEFF€", stderr: "\uFEFF雪", code: 0, killed: false });
	});

	it.skipIf(process.platform === "win32")(
		"force-kills a real child that ignores SIGTERM at the existing deadline",
		async () => {
			const pending = execCommand(
				process.execPath,
				[
					"-e",
					"process.on('SIGTERM',()=>process.stdout.write('TERM'));process.stdout.write('READY');setInterval(()=>{},1000)",
				],
				process.cwd(),
				{ timeout: 1000 },
			);
			const child = vi.mocked(spawn).mock.results.at(-1)!.value as ReturnType<typeof spawn>;
			onTestFinished(() => {
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			});
			const result = await pending;
			expect(result.killed).toBe(true);
			expect(result.stdout).toBe("READYTERM");
			expect(child.signalCode).toBe("SIGKILL");
		},
		10000,
	);
});
