import { EventEmitter } from "node:events";
import { fstatSync, ReadStream, readFileSync, readSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import type * as Undici from "undici";
import { fetch, Response } from "undici";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import type { BorderedLoader } from "../src/modes/interactive/components/bordered-loader.ts";

const childProcessMocks = vi.hoisted(() => ({
	spawn: vi.fn(),
	spawnSync: vi.fn(() => ({ status: 0 })),
}));

vi.mock("node:child_process", () => childProcessMocks);
vi.mock("undici", async (importOriginal) => ({
	...(await importOriginal<typeof Undici>()),
	fetch: vi.fn(),
}));

import { shareSession } from "../src/modes/interactive/session-share.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("shareSession", () => {
	beforeAll(() => initTheme("dark"));
	afterEach(() => vi.clearAllMocks());

	it.each([false, true])(
		"Radius streams the complete exported bytes and closes cancellation (cancel: %s)",
		async (cancel) => {
			const manager = SessionManager.inMemory("/tmp");
			manager.appendMessage({ role: "user", content: `雪${"large text ".repeat(30_000)}`, timestamp: 1 });
			const statuses: string[] = [];
			const errors: string[] = [];
			let upload: ReadStream | undefined;
			let descriptor: number | undefined;
			let loader: BorderedLoader | undefined;
			const context = {
				session: {
					sessionManager: manager,
					state: { systemPrompt: "share prompt", tools: [] },
					modelRuntime: {
						getProvider: () => ({}),
						getAuth: async () => ({ auth: { apiKey: "fake-share-token" } }),
					},
				},
				ui: {
					setFocus(component: BorderedLoader) {
						loader = component;
					},
					requestRender() {},
				},
				editorContainer: { clear() {}, addChild() {} },
				editor: {},
				showStatus: (message: string) => statuses.push(message),
				showError: (message: string) => errors.push(message),
			};
			vi.mocked(fetch).mockImplementation(async (_url, options) => {
				expect(options?.body).toBeInstanceOf(ReadStream);
				if (!(options?.body instanceof ReadStream)) throw new Error("expected file stream");
				upload = options.body;
				const fd: unknown = Reflect.get(upload, "fd");
				if (typeof fd !== "number") throw new Error("expected captured file descriptor");
				descriptor = fd;
				const headers = options.headers as Record<string, string>;
				const size = fstatSync(fd).size;
				expect(headers).toMatchObject({
					Authorization: "Bearer fake-share-token",
					"Content-Type": "application/x-ndjson",
					"Content-Length": String(size),
				});
				expect(options.duplex).toBe("half");
				if (cancel) {
					loader!.handleInput("\x1b");
					expect(options.signal?.aborted).toBe(true);
					throw new Error("cancelled");
				}
				const expected = Buffer.alloc(size);
				let position = 0;
				while (position < size) position += readSync(fd, expected, position, size - position, position);
				const chunks: Buffer[] = [];
				for await (const chunk of upload) chunks.push(Buffer.from(chunk));
				expect(chunks.length).toBeGreaterThan(1);
				expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeLessThanOrEqual(64 * 1024);
				expect(Buffer.concat(chunks)).toEqual(expected);
				const records = expected
					.toString("utf8")
					.trimEnd()
					.split("\n")
					.map((line) => JSON.parse(line));
				expect(records[1]).toMatchObject({ message: { content: `雪${"large text ".repeat(30_000)}` } });
				expect(records.at(-1)).toMatchObject({
					type: "custom",
					customType: "pi.share",
					data: { systemPrompt: "share prompt", tools: [] },
				});
				return new Response('{"artifact":{"canonical_url":"https://example.invalid/shared"}}');
			});
			await shareSession(context as never);
			expect(errors).toEqual([]);
			expect(statuses.join(" ")).toContain(cancel ? "Share cancelled" : "https://example.invalid/shared");
			expect(upload?.destroyed).toBe(true);
			expect(() => fstatSync(descriptor!)).toThrow();
			expect(childProcessMocks.spawn).not.toHaveBeenCalled();
		},
	);

	it("keeps concurrent session exports isolated", async () => {
		const uploads: string[] = [];
		childProcessMocks.spawn.mockImplementation((_command, args: string[]) => {
			uploads.push(readFileSync(args.at(-1)!, "utf8"));
			const child = Object.assign(new EventEmitter(), {
				stdout: new PassThrough(),
				stderr: new PassThrough(),
				kill: vi.fn(),
			});
			queueMicrotask(() => {
				child.stdout.end(`https://gist.github.com/test/${uploads.length}\n`);
				child.stderr.end();
				child.emit("close", 0);
			});
			return child;
		});

		const aWritten = deferred();
		const bWritten = deferred();
		const releaseB = deferred();
		const errors: string[] = [];
		const context = (name: "A" | "B") => ({
			session: {
				sessionManager: SessionManager.inMemory("/tmp"),
				state: { systemPrompt: name, tools: [] },
				modelRuntime: { getProvider: () => undefined },
				exportToHtml: async (filePath: string) => {
					writeFileSync(filePath, name);
					if (name === "A") {
						aWritten.resolve();
						await bWritten.promise;
					} else {
						bWritten.resolve();
						await releaseB.promise;
					}
				},
			},
			ui: { setFocus() {}, requestRender() {} },
			editorContainer: { clear() {}, addChild() {} },
			editor: {},
			showStatus() {},
			showError(message: string) {
				errors.push(message);
			},
		});

		const shareA = shareSession(context("A") as never);
		await aWritten.promise;
		const shareB = shareSession(context("B") as never);
		await bWritten.promise;
		await shareA;
		releaseB.resolve();
		await shareB;

		expect(uploads).toEqual(["A", "B"]);
		expect(errors).toEqual([]);
	});
});
