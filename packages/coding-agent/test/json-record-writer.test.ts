import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeJsonRecordToStdout, writeJsonValue } from "../src/core/json-record-writer.ts";
import { flushRawStdout } from "../src/core/output-guard.ts";
import { jsonEventLayout } from "../src/modes/json-event.ts";
import { rpcOutputLayout } from "../src/modes/rpc/jsonl.ts";

const temporaryBase = tmpdir();
let temporaryDirectory: string;
beforeEach(() => {
	temporaryDirectory = mkdtempSync(join(temporaryBase, "pi-wire-writer-test-"));
	for (const key of ["TMPDIR", "TMP", "TEMP"]) vi.stubEnv(key, temporaryDirectory);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe("native JSON record writer", () => {
	it("snapshots ordinary deltas, headers and small responses in native byte order without file stages", async () => {
		const header = { type: "session", version: 3, id: "fixture", timestamp: "2024-01-01", cwd: "/fixture" };
		const events = [
			header,
			...Array.from({ length: 1000 }, (_, index) => ({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: `delta ${index}🙂\u2028` },
			})),
			{ type: "response", id: "ready", command: "prompt", success: true, data: { disposition: "started" } },
		];
		const expected = events.map((event) => `${JSON.stringify(event)}\n`).join("");
		const writes: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation(((chunk, callback) => {
			writes.push(String(chunk));
			if (typeof callback === "function") queueMicrotask(() => callback());
			return true;
		}) as typeof process.stdout.write);
		for (const event of events) writeJsonRecordToStdout(event, rpcOutputLayout);
		const stagesBeforeDrain = readdirSync(tmpdir());
		header.cwd = "mutated after snapshot";
		await flushRawStdout();
		expect(stagesBeforeDrain).toEqual([]);
		expect(writes.join("")).toBe(expected);
		expect(readdirSync(tmpdir())).toEqual([]);
	});

	it("matches native property order, omission/null and toJSON keys across native aggregates", () => {
		const keyed = () => ({ toJSON: (key: string) => key });
		const messages = [keyed(), undefined, null, NaN, -0];
		messages.length++;
		messages.push(keyed());
		const value = {
			type: "agent_end",
			omitted: undefined,
			messages,
			steering: [keyed()],
			followUp: [],
			extra: { date: new Date("2020-01-01"), unicode: "a\u2028b\u2029c🙂", keyed: keyed() },
		};
		const chunks: string[] = [];
		writeJsonValue(value, (text) => chunks.push(text), jsonEventLayout);
		expect(chunks.join("")).toBe(JSON.stringify(value));
	});

	it("calls custom container toJSON once with its native key, retaining native return semantics", () => {
		const calls: string[] = [];
		const messages = Object.assign([1, 2], {
			get toJSON() {
				calls.push("get");
				return (key: string) => {
					calls.push(key);
					return { toJSON: () => "must not run again", value: "replacement" };
				};
			},
		});
		const chunks: string[] = [];
		writeJsonValue({ type: "agent_end", messages }, (text) => chunks.push(text), jsonEventLayout);
		expect(chunks.join("")).toBe('{"type":"agent_end","messages":{"value":"replacement"}}');
		expect(calls).toEqual(["get", "messages"]);
	});

	it("does not turn a callable toJSON property value into a wrapper hook", () => {
		const value = () => {
			let reads = 0;
			return {
				get toJSON() {
					return reads++ === 0
						? null
						: () => {
								throw new Error("property must be omitted");
							};
				},
				messages: ["kept"],
			};
		};
		const expected = JSON.stringify(value());
		const chunks: string[] = [];
		writeJsonValue(value(), (text) => chunks.push(text), jsonEventLayout);
		expect(chunks.join("")).toBe(expected);
	});

	it("routes owned accessors without invoking them or their payload hooks early", async () => {
		const calls: string[] = [];
		const value = {
			type: "response",
			get data() {
				calls.push("data");
				return {
					messages: [
						{
							toJSON: (key: string) => {
								calls.push(key);
								return "kept";
							},
						},
					],
				};
			},
		};
		const stdout = vi.spyOn(process.stdout, "write");
		writeJsonRecordToStdout(value, rpcOutputLayout);
		await flushRawStdout();
		expect(calls).toEqual(["data", "0"]);
		expect(stdout.mock.calls.map(([chunk]) => String(chunk)).join("")).toBe(
			'{"type":"response","data":{"messages":["kept"]}}\n',
		);
	});

	it("frames complete entry trees iteratively rather than serializing a root subtree", () => {
		type Node = { entry: { id: number }; children: Node[]; label?: string };
		const root: Node = { entry: { id: 0 }, children: [] };
		let node = root;
		for (let i = 1; i <= 10000; i++) {
			const child: Node = { entry: { id: i }, children: [] };
			node.children.push(child);
			node = child;
		}
		let bytes = 0;
		let largestChunk = 0;
		writeJsonValue(
			{ type: "response", data: { tree: [root], leafId: "10000" } },
			(text) => {
				bytes += text.length;
				largestChunk = Math.max(largestChunk, text.length);
			},
			rpcOutputLayout,
		);
		expect(bytes).toBeGreaterThan(300000);
		expect(largestChunk).toBeLessThan(100);
		const smallTree = { data: { tree: [{ entry: { id: 1 }, children: [], label: "kept" }] } };
		const chunks: string[] = [];
		writeJsonValue(smallTree, (text) => chunks.push(text), rpcOutputLayout);
		expect(chunks.join("")).toBe(JSON.stringify(smallTree));
	});

	it.each(["BigInt", "cycle", "toJSON"] as const)(
		"rejects a late %s member without publishing bytes and removes its private stage",
		async (failure) => {
			const circular: Record<string, unknown> = {};
			circular.self = circular;
			const invalid =
				failure === "BigInt"
					? 1n
					: failure === "cycle"
						? circular
						: {
								toJSON: () => {
									throw new Error("bad leaf");
								},
							};
			const value = { type: "agent_end", messages: ["valid".repeat(20000), invalid] };
			const before = readdirSync(tmpdir())
				.filter((name) => name.startsWith("pi-json-record-"))
				.sort();
			const stdout = vi.spyOn(process.stdout, "write");
			expect(() => JSON.stringify(value)).toThrow();
			expect(() => writeJsonRecordToStdout(value, jsonEventLayout)).toThrow(
				failure === "toJSON" ? "bad leaf" : TypeError,
			);
			await flushRawStdout();
			expect(stdout.mock.calls.map(([chunk]) => String(chunk)).join("")).toBe("");
			expect(
				readdirSync(tmpdir())
					.filter((name) => name.startsWith("pi-json-record-"))
					.sort(),
			).toEqual(before);
		},
	);

	it("keeps complete record order and bounded writes while a slow pipe applies backpressure", async () => {
		const before = readdirSync(tmpdir())
			.filter((name) => name.startsWith("pi-json-record-"))
			.sort();
		const aggregate = { type: "agent_end", messages: ["🙂".repeat(60000), "second member"] };
		const records = [
			{ type: "agent_start" },
			aggregate,
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "between aggregates" } },
			{ type: "queue_update", steering: ["later"], followUp: [] },
			{ type: "agent_settled" },
		];
		const chunks: Buffer[] = [];
		let pending = 0;
		let maxPending = 0;
		vi.spyOn(process.stdout, "write").mockImplementation(((chunk, callback) => {
			pending++;
			maxPending = Math.max(pending, maxPending);
			chunks.push(Buffer.from(chunk));
			setTimeout(() => {
				pending--;
				if (typeof callback === "function") callback();
			}, 1);
			return false;
		}) as typeof process.stdout.write);
		for (const value of records) writeJsonRecordToStdout(value, jsonEventLayout);
		if (process.platform !== "win32") {
			for (const directory of readdirSync(tmpdir())) {
				expect(statSync(join(tmpdir(), directory, "record")).mode & 0o777).toBe(0o600);
			}
		}
		aggregate.messages[0] = "mutated after synchronous staging";
		await flushRawStdout();
		expect(maxPending).toBe(1);
		expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeLessThanOrEqual(65536);
		const delivered = Buffer.concat(chunks)
			.toString("utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		expect(delivered).toEqual([
			{ type: "agent_start" },
			{ type: "agent_end", messages: ["🙂".repeat(60000), "second member"] },
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "between aggregates" } },
			{ type: "queue_update", steering: ["later"], followUp: [] },
			{ type: "agent_settled" },
		]);
		expect(
			readdirSync(tmpdir())
				.filter((name) => name.startsWith("pi-json-record-"))
				.sort(),
		).toEqual(before);
	});

	it("retries ENOBUFS without duplicating record bytes", async () => {
		const output: Buffer[] = [];
		let attempts = 0;
		vi.spyOn(process.stdout, "write").mockImplementation(((chunk, callback) => {
			const error = attempts++ === 0 ? Object.assign(new Error("busy pipe"), { code: "ENOBUFS" }) : undefined;
			if (!error) output.push(Buffer.from(chunk));
			if (typeof callback === "function") callback(error);
			return !error;
		}) as typeof process.stdout.write);
		writeJsonRecordToStdout({ type: "agent_settled" }, jsonEventLayout);
		await flushRawStdout();
		expect(Buffer.concat(output).toString()).toBe('{"type":"agent_settled"}\n');
		expect(attempts).toBe(3); // Failed write, retry, final flush.
	});

	it.each(["disconnect", "exit"] as const)(
		"removes owned records on a real stdout %s before drain",
		async (failure) => {
			const directory = mkdtempSync(join(tmpdir(), "pi-wire-disconnect-"));
			const child = spawn(
				process.execPath,
				[fileURLToPath(new URL("./fixtures/rpc-large-wire.mjs", import.meta.url))],
				{
					env: {
						...process.env,
						TMPDIR: directory,
						PI_WIRE_MESSAGE_COUNT: "2",
						PI_WIRE_EXIT_BEFORE_DRAIN: failure === "exit" ? "1" : "",
					},
					stdio: ["pipe", "pipe", "pipe"],
				},
			);
			let stderr = "";
			child.stderr.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});
			const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
			if (failure === "disconnect") child.stdout.destroy();
			else child.stdout.resume();
			child.stdin.end('{"type":"set_session_name","id":"disconnect"}\n');
			try {
				expect(await closed, stderr).toBe(failure === "exit" ? 143 : 1);
				expect(readdirSync(directory)).toEqual([]);
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		},
	);
});
