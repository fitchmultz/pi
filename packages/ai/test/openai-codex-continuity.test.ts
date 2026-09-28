import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { closeOpenAICodexWebSocketSessions, stream, streamSimple } from "../src/api/openai-codex-responses.ts";
import { cleanupSessionResources } from "../src/session-resources.ts";
import type { AssistantMessageEvent, Context, Model, ResponseControl } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import { createResponsesServer, type LocalResponsesRequest, replyWithOutput } from "./responses-websocket-server.ts";

const token = (account = "local", revision = "x") =>
	`${revision}.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.x`;
const options = () => ({
	apiKey: token(),
	sessionId: "continuity",
	turnScope: {},
	transport: "websocket-cached" as const,
	timeoutMs: 1000,
});
const context = (): Context => ({ messages: [{ role: "user", content: "hello", timestamp: 1 }] });
const model = (baseUrl: string): Model<"openai-codex-responses"> => ({
	id: "gpt-6-astra",
	name: "Local Codex",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl,
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10000,
	maxTokens: 1000,
	compat: { supportsAsyncTools: true, supportsSteering: true },
});
afterEach(() => {
	cleanupSessionResources();
	vi.unstubAllGlobals();
});

// These tests assert actual frame contents/socket identity, not the adapter's private cache representation.
describe("Codex continuation ownership", () => {
	it("snapshots sent request values before hooks can mutate them", async () => {
		vi.stubGlobal("WebSocket", WebSocket);
		let captured: { input: { content: { text: string }[] }[] } | undefined;
		const fixture = await createResponsesServer((request) => {
			if (fixture.requests.length === 1) captured!.input[0].content[0].text = "mutated after send";
			replyWithOutput(request, `r${fixture.requests.length}`, []);
		});
		try {
			const history = context();
			const opts = options();
			const first = await stream(model(fixture.baseUrl), normalizeContext(history), {
				...opts,
				onPayload(body) {
					captured = body as typeof captured;
				},
			}).result();
			history.messages.push(first, { role: "user", content: "next", timestamp: 2 });
			const second = await stream(model(fixture.baseUrl), normalizeContext(history), opts).result();
			expect(first.stopReason).toBe("stop");
			expect(second.stopReason).toBe("stop");
			expect(fixture.requests[1].body.previous_response_id).toBe("r1");
			expect(fixture.requests[1].body.input).toEqual([
				{ role: "user", content: [{ type: "input_text", text: "next" }] },
			]);
			expect(fixture.errors).toEqual([]);
		} finally {
			await fixture.close();
		}
	});

	it("replays a changed native async item instead of silently omitting its mutation", async () => {
		vi.stubGlobal("WebSocket", WebSocket);
		const call = {
			type: "function_call",
			id: "fc1",
			call_id: "call1",
			name: "work",
			arguments: "{}",
			async: true,
			status: "completed",
		};
		const fixture = await createResponsesServer((request) =>
			replyWithOutput(request, `r${fixture.requests.length}`, fixture.requests.length === 1 ? [call] : []),
		);
		try {
			const history = context();
			const opts = options();
			const route = model(fixture.baseUrl);
			const first = await stream(route, normalizeContext(history), opts).result();
			const output = first.content.find((block) => block.type === "toolCall");
			expect(output?.responsesItem).toMatchObject(call);
			if (!output?.responsesItem || output.responsesItem.type !== "function_call")
				throw new Error("Missing native call");
			output.responsesItem.arguments = '{"changed":true}';
			history.messages.push(first, { role: "user", content: "continue", timestamp: 2 });
			await stream(route, normalizeContext(history), opts).result();
			expect(fixture.requests[1].body.previous_response_id).toBeUndefined();
			expect(fixture.requests[1].body.input).toContainEqual({ ...call, arguments: '{"changed":true}' });
			// The new full baseline must also be detached from replayed input objects.
			output.responsesItem.arguments = '{"changed":false}';
			history.messages.push({ role: "user", content: "again", timestamp: 3 });
			await stream(route, normalizeContext(history), opts).result();
			expect(fixture.requests[2].body.previous_response_id).toBeUndefined();
			expect(fixture.requests[2].body.input).toContainEqual({ ...call, arguments: '{"changed":false}' });
			expect(fixture.errors).toEqual([]);
		} finally {
			await fixture.close();
		}
	});
});

describe("Codex turn-state", () => {
	it.each([
		["string", { type: "response.metadata", headers: { "X-Codex-Turn-State": "issued" } }, "issued"],
		[
			"first nested array member",
			{ type: "response.metadata", headers: { "x-codex-turn-state": [["issued", "ignored"]] } },
			"issued",
		],
		["empty string", { type: "response.metadata", headers: { "x-codex-turn-state": "" } }, ""],
		["missing header", { type: "response.metadata", headers: {} }, undefined],
		[
			"invalid first member",
			{ type: "response.metadata", headers: { "x-codex-turn-state": [null, "ignored"] } },
			undefined,
		],
		[
			"Codex-specific discriminator",
			{ type: "codex.response.metadata", headers: { "x-codex-turn-state": "ignored" } },
			undefined,
		],
	] as const)("latches only eligible %s without changing delta eligibility", async (_name, event, expected) => {
		vi.stubGlobal("WebSocket", WebSocket);
		const fixture = await createResponsesServer((request) => {
			request.send(event);
			if (expected !== undefined)
				request.send({ type: "response.metadata", headers: { "x-codex-turn-state": "later" } });
			replyWithOutput(request, `r${fixture.requests.length}`, []);
		});
		try {
			const history = context();
			const opts = options();
			const route = model(fixture.baseUrl);
			history.messages.push(await streamSimple(route, normalizeContext(history), opts).result(), {
				role: "user",
				content: "next",
				timestamp: 2,
			});
			await streamSimple(route, normalizeContext(history), opts).result();
			expect(fixture.requests[0].body).not.toHaveProperty("client_metadata");
			if (expected === undefined) expect(fixture.requests[1].body).not.toHaveProperty("client_metadata");
			else expect(fixture.requests[1].body).toHaveProperty("client_metadata", { "x-codex-turn-state": expected });
			expect(fixture.requests[1].body.previous_response_id).toBe("r1");
			expect(fixture.requests[1].body.input).toEqual([
				{ role: "user", content: [{ type: "input_text", text: "next" }] },
			]);
			expect(fixture.errors).toEqual([]);
		} finally {
			await fixture.close();
		}
	});

	it("retains state across reconnects but not new turns, absent scopes, account switches or auth revisions", async () => {
		vi.stubGlobal("WebSocket", WebSocket);
		const fixture = await createResponsesServer((request) => {
			request.send({
				type: "response.metadata",
				headers: { "x-codex-turn-state": `issued${fixture.requests.length}` },
			});
			replyWithOutput(request, `r${fixture.requests.length}`, []);
		});
		try {
			const opts = options();
			const route = model(fixture.baseUrl);
			const history = normalizeContext(context());
			await stream(route, history, opts).result();
			closeOpenAICodexWebSocketSessions(opts.sessionId);
			await stream(route, history, opts).result();
			expect(fixture.requests[1].connection).not.toBe(fixture.requests[0].connection);
			expect(fixture.requests[1].body).toHaveProperty("client_metadata", { "x-codex-turn-state": "issued1" });
			const next = { ...opts, turnScope: {} };
			await stream(route, history, next).result();
			await stream(route, history, { ...next, apiKey: token("other") }).result();
			await stream(route, history, next).result();
			await stream(route, history, { ...next, apiKey: token("local", "renewed") }).result();
			await stream(route, history, { ...opts, turnScope: undefined }).result();
			await stream(route, history, { ...opts, turnScope: undefined }).result();
			for (const request of fixture.requests.slice(2)) expect(request.body).not.toHaveProperty("client_metadata");
			expect(fixture.errors).toEqual([]);
		} finally {
			await fixture.close();
		}
	});

	it("reconnects after metadata-only failure and echoes the token on the retry", async () => {
		vi.stubGlobal("WebSocket", WebSocket);
		const fixture = await createResponsesServer((request) => {
			if (fixture.requests.length === 1) {
				request.send({ type: "response.metadata", headers: { "x-codex-turn-state": "issued" } });
				request.socket!.close(1012);
			} else replyWithOutput(request, "retry", []);
		});
		try {
			const result = await stream(model(fixture.baseUrl), normalizeContext(context()), options()).result();
			expect(result.stopReason).toBe("stop");
			expect(fixture.requests).toHaveLength(2);
			expect(fixture.requests[1].body).toHaveProperty("client_metadata", { "x-codex-turn-state": "issued" });
			expect(fixture.requests[1].body.previous_response_id).toBeUndefined();
			expect(fixture.errors).toEqual([]);
		} finally {
			await fixture.close();
		}
	});
});

describe("Codex steering connection safety", () => {
	it("reconnects with full input when steering send throws on an otherwise open socket", async () => {
		const frames: { connection: number; raw: string; body: Record<string, unknown> }[] = [];
		let connections = 0;
		let steerAttempts = 0;
		class Socket extends EventTarget {
			readyState = 1;
			connection = ++connections;
			constructor() {
				super();
				queueMicrotask(() => this.dispatchEvent(new Event("open")));
			}
			close() {
				this.readyState = 3;
			}
			send(raw: string) {
				const body = JSON.parse(raw) as Record<string, unknown>;
				if (body.type === "response.steer") {
					steerAttempts++;
					expect(this.readyState).toBe(1);
					queueMicrotask(() =>
						this.dispatchEvent(
							new MessageEvent("message", {
								data: JSON.stringify({
									type: "response.completed",
									response: { id: "parent", status: "completed", output: [] },
								}),
							}),
						),
					);
					throw new Error("send failed without closing socket");
				}
				frames.push({ connection: this.connection, raw, body });
				queueMicrotask(() => {
					const id = frames.length === 1 ? "parent" : "next";
					this.dispatchEvent(
						new MessageEvent("message", { data: JSON.stringify({ type: "response.created", response: { id } }) }),
					);
					if (frames.length > 1)
						this.dispatchEvent(
							new MessageEvent("message", {
								data: JSON.stringify({
									type: "response.completed",
									response: { id, status: "completed", output: [] },
								}),
							}),
						);
				});
			}
		}
		vi.stubGlobal("WebSocket", Socket);
		const opts = options();
		const route = model("https://example.invalid");
		const history = context();
		const input = { role: "user" as const, content: "steering input", timestamp: 2 };
		let expectedFirstFrame: string | undefined;
		const response = stream(route, normalizeContext(history), {
			...opts,
			onPayload(body) {
				expectedFirstFrame = JSON.stringify({ type: "response.create", ...(body as Record<string, unknown>) });
			},
			onResponseControl(control) {
				control?.steer(input);
			},
		});
		const statuses: string[] = [];
		for await (const event of response) if (event.type === "steering") statuses.push(event.status);
		const first = await response.result();
		expect(first.stopReason).toBe("stop");
		expect(steerAttempts).toBe(1);
		expect(statuses).toEqual(["queued", "unknown"]);
		expect(frames[0].raw).toBe(expectedFirstFrame);
		history.messages.push(first, input);
		expect((await stream(route, normalizeContext(history), opts).result()).stopReason).toBe("stop");
		expect(frames).toHaveLength(2);
		expect(frames[1].connection).not.toBe(frames[0].connection);
		expect(frames[1].body.previous_response_id).toBeUndefined();
		expect(frames[1].body.input).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "hello" }] },
			{ role: "user", content: [{ type: "input_text", text: "steering input" }] },
		]);
	});

	it("declines steering when the terminal frame has arrived but earlier events are still queued", async () => {
		const frames: Record<string, unknown>[] = [];
		let connections = 0;
		class Socket extends EventTarget {
			readyState = 1;
			constructor() {
				super();
				connections++;
				queueMicrotask(() => this.dispatchEvent(new Event("open")));
			}
			close() {
				this.readyState = 3;
			}
			send(data: string) {
				frames.push(JSON.parse(data));
				queueMicrotask(() => {
					const id = `r${frames.length}`;
					for (const event of [
						{ type: "response.created", response: { id } },
						{ type: "response.completed", response: { id, status: "completed", output: [] } },
					])
						this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
				});
			}
		}
		vi.stubGlobal("WebSocket", Socket);
		const opts = options();
		const route = model("https://example.invalid");
		const history = context();
		const input = { role: "user" as const, content: "late update", timestamp: 2 };
		const admissions: boolean[] = [];
		const first = await stream(route, normalizeContext(history), {
			...opts,
			onResponseControl(control) {
				if (control && admissions.length === 0) admissions.push(control.steer(input));
			},
		}).result();
		expect(first.stopReason).toBe("stop");
		expect(admissions).toEqual([false]);
		history.messages.push(first, input);
		await stream(route, normalizeContext(history), opts).result();
		expect(frames).toHaveLength(2);
		expect(connections).toBe(1);
		expect(frames[1].input).toEqual([{ role: "user", content: [{ type: "input_text", text: "late update" }] }]);
	});

	it.each(["applied", "failed", "disconnected", "pending", "abnormal", "timeout", "aborted"] as const)(
		"retains only a consistent %s chain; never puts turn-state on steer",
		async (mode) => {
			vi.stubGlobal("WebSocket", WebSocket);
			let parent: LocalResponsesRequest | undefined;
			let control: ResponseControl | undefined;
			let steered = false;
			const abort = new AbortController();
			const lost = ["disconnected", "abnormal", "timeout", "aborted"].includes(mode);
			const fixture = await createResponsesServer((request) => {
				const body = request.body as { type?: string; previous_response_id?: string };
				if (body.type === "response.steer") {
					const steer = { id: "s1", previous_response_id: "parent" };
					request.send({ type: "response.steer.accepted", steer });
					parent!.send({
						type: "response.completed",
						response: { id: "parent", status: "completed", output: [] },
					});
					if (mode === "disconnected") request.socket!.close(1000, "secret-token-do-not-log");
					else if (mode === "abnormal") request.socket!.terminate();
					else if (mode === "timeout" || mode === "aborted") return;
					else if (mode === "failed")
						request.send({ type: "response.steer.failed", steer, error: { message: "rejected" } });
					else if (mode === "pending")
						request.send({
							type: "response.steer.pending",
							steer,
							required_input: [{ type: "function_call_output", call_id: "call1" }],
						});
					else replyWithOutput(request, "successor", []);
				} else if (!parent) {
					parent = request;
					request.send({ type: "response.metadata", headers: { "x-codex-turn-state": "issued" } });
					request.send({ type: "response.created", response: { id: "parent" } });
				} else replyWithOutput(request, `r${fixture.requests.length}`, []);
			});
			try {
				const opts = options();
				const route = model(fixture.baseUrl);
				const response = stream(route, normalizeContext(context()), {
					...opts,
					timeoutMs: mode === "timeout" ? 100 : 1000,
					signal: abort.signal,
					onResponseControl(value) {
						control = value;
						if (!control || steered) return;
						steered = true;
						control.submitToolResults([
							{
								role: "toolResult",
								toolCallId: "call1",
								toolName: "work",
								content: [{ type: "text", text: "result" }],
								isError: false,
								timestamp: 2,
							},
						]);
						control.steer({ role: "user", content: "new input", timestamp: 2 });
					},
				});
				const statuses: string[] = [];
				let unknown: Extract<AssistantMessageEvent, { type: "steering" }> | undefined;
				for await (const event of response) {
					if (event.type === "response_end" && mode === "aborted") abort.abort();
					if (event.type === "steering") {
						statuses.push(event.status);
						if (event.status === "unknown") unknown = event;
					}
				}
				expect((await response.result()).stopReason).toBe(
					mode === "aborted" ? "aborted" : mode === "abnormal" || mode === "timeout" ? "error" : "stop",
				);
				expect(statuses.at(-1)).toBe(lost ? "unknown" : mode === "failed" ? "failed" : "applied");
				if (lost) {
					expect(unknown?.diagnostic).toMatchObject({
						type: "provider_transport_close",
						details: {
							pendingSteerStatus: "accepted",
							closeInitiator: mode === "disconnected" ? "remote" : mode === "abnormal" ? "unknown" : "local",
						},
					});
					expect(unknown?.diagnostic?.details?.sinceParentTerminalMs).toBeGreaterThanOrEqual(0);
					if (mode === "disconnected")
						expect(unknown?.diagnostic?.details).toMatchObject({ closeCode: 1000, closeReason: "redacted" });
					expect(JSON.stringify(unknown?.diagnostic)).not.toContain("secret-token-do-not-log");
				}
				expect(fixture.requests[1].body).not.toHaveProperty("client_metadata");
				if (mode === "pending")
					expect(fixture.requests[2].body).toHaveProperty("client_metadata", { "x-codex-turn-state": "issued" });
				await stream(route, normalizeContext(context()), opts).result();
				const next = fixture.requests.at(-1)!;
				expect(next.connection === parent!.connection).toBe(!lost);
				expect(next.body.previous_response_id).toBeUndefined();
				expect(next.body).toHaveProperty("client_metadata", { "x-codex-turn-state": "issued" });
				expect(fixture.errors).toEqual([]);
			} finally {
				await fixture.close();
			}
		},
	);
});
