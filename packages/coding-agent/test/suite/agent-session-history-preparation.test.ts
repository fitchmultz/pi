import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import { type FileEntry, type SessionEntry, SessionManager } from "../../src/core/session-manager.ts";
import { createHarness } from "./harness.ts";

const noop: AgentTool = {
	name: "noop",
	label: "Noop",
	description: "Local no-op",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text", text: "tool result" }], details: {} }),
};

vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof fs>();
	return { ...actual, readSync: vi.fn(actual.readSync), statSync: vi.fn(actual.statSync) };
});

it("prepares a tool successor without rereading unchanged history and preserves the provider transcript", async () => {
	const directory = fs.mkdtempSync(join(tmpdir(), "pi-next-turn-history-"));
	const manager = SessionManager.create(directory, directory);
	const historical = Array.from({ length: 256 }, (_, index) => `historical-${index}`);
	for (const [index, content] of historical.entries())
		manager.appendMessage({ role: "user", content, timestamp: index });
	const harness = await createHarness({
		sessionManager: SessionManager.open(manager.getSessionFile()!),
		models: [{ id: "faux-1", contextWindow: 1_000_000 }],
		tools: [noop],
		settings: { compaction: { enabled: false }, retry: { enabled: false } },
	});
	try {
		const requests: string[] = [];
		harness.setResponses([
			(context) => {
				requests.push(JSON.stringify(context));
				return fauxAssistantMessage(fauxToolCall("noop", {}, { id: "call-noop" }), { stopReason: "toolUse" });
			},
			(context) => {
				requests.push(JSON.stringify(context));
				return fauxAssistantMessage("done");
			},
		]);
		vi.mocked(fs.readSync).mockClear();
		vi.mocked(fs.statSync).mockClear();
		await harness.session.prompt("next input");
		expect(requests).toHaveLength(2);
		for (const request of requests) {
			const positions = historical.map((content) => request.indexOf(`"${content}"`));
			expect(
				positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1])),
			).toBe(true);
		}
		expect(requests[1]).toContain("call-noop");
		expect(requests[1]).toContain("tool result");
		expect(vi.mocked(fs.readSync).mock.calls.length).toBeLessThan(32);
		expect(
			vi.mocked(fs.statSync).mock.calls.filter(([path]) => path === manager.getSessionFile()).length,
		).toBeLessThan(128);
		expect(harness.sessionManager.buildSessionContext().messages).toEqual(harness.session.messages);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	} finally {
		harness.cleanup();
		vi.restoreAllMocks();
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

it.each([false, true])("isolates provider mutations without context handlers (persisted: %s)", async (persisted) => {
	const directory = fs.mkdtempSync(join(tmpdir(), "pi-provider-isolation-"));
	const manager = persisted ? SessionManager.create(directory, directory) : SessionManager.inMemory(directory);
	const id = manager.appendMessage({ role: "user", content: "original history", timestamp: 1 });
	const harness = await createHarness({ sessionManager: manager, settings: { compaction: { enabled: false } } });
	try {
		harness.setResponses([
			(context) => {
				for (const message of context.messages) if (message.role === "user") message.content = "provider mutation";
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("original input");
		expect(manager.getEntry(id)).toMatchObject({ message: { content: "original history" } });
		const canonical = JSON.stringify(manager.buildSessionProjection().messages);
		expect(canonical).toContain("original input");
		expect(canonical).not.toContain("provider mutation");
	} finally {
		harness.cleanup();
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

it("does not decode retained assistant bodies for usage during a tool turn", async () => {
	const bodyReads: number[] = [];
	for (const count of [10, 240]) {
		const directory = fs.mkdtempSync(join(tmpdir(), "pi-assistant-history-"));
		const manager = SessionManager.create(directory, directory);
		const harness = await createHarness({
			sessionManager: manager,
			models: [{ id: "faux-1", contextWindow: 1_000_000 }],
			tools: [noop],
			settings: { compaction: { enabled: false }, retry: { enabled: false } },
		});
		const read = vi.mocked(fs.readSync);
		const original = read.getMockImplementation()!;
		try {
			const model = harness.getModel();
			for (let index = 0; index < count; index++) {
				manager.appendMessage({ role: "user", content: `input ${index}`, timestamp: index });
				manager.appendMessage({
					...fauxAssistantMessage("a".repeat(2048)),
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 100,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 101,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				});
			}
			harness.session.refreshContext();
			let reads = 0;
			read.mockImplementation((...args: Parameters<typeof fs.readSync>) => {
				// Range certification is byte-sensitive; individual body decoding must not scale with assistant count.
				if (new Error().stack?.includes("visitJournalRecord")) reads++;
				return original(...args);
			});
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("noop", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxToolCall("noop", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("next");
			bodyReads.push(reads);
			expect(harness.faux.state.callCount).toBe(3);
		} finally {
			read.mockImplementation(original);
			harness.cleanup();
			fs.rmSync(directory, { recursive: true, force: true });
		}
	}
	expect(bodyReads[1]).toBe(bodyReads[0]);
	expect(bodyReads[1]).toBeLessThan(32);
});

it.each(["setup", "failed edit"] as const)(
	"isolates unflushed persisted context from provider mutations (%s)",
	async (kind) => {
		const directory = fs.mkdtempSync(join(tmpdir(), "pi-dirty-provider-"));
		const manager = SessionManager.create(directory, directory);
		manager.appendMessage({ role: "system", content: "original system", timestamp: 1 });
		const content = [{ type: "text" as const, text: "original custom" }];
		const customId = manager.appendCustomMessageEntry("input", content, false, { original: true });
		if (kind === "failed edit") {
			manager.appendMessage({ role: "user", content: "saved input", timestamp: 2 });
			const append = vi.spyOn(fs, "appendFileSync").mockImplementationOnce(() => {
				throw new Error("write failed");
			});
			try {
				expect(() =>
					manager.appendContextEdit(customId, { content: [{ type: "text", text: "original edited custom" }] }),
				).toThrow("write failed");
			} finally {
				append.mockRestore();
			}
		}
		const harness = await createHarness({
			sessionManager: manager,
			tools: [],
			settings: { compaction: { enabled: false } },
		});
		try {
			expect(fs.existsSync(manager.getSessionFile()!)).toBe(kind !== "setup");
			harness.setResponses([
				(context) => {
					for (const message of context.messages) {
						if (message.role === "system") message.content = "mutated system";
						if (message.role === "user" && Array.isArray(message.content)) {
							const text = message.content.find((block) => block.type === "text");
							if (text) text.text = "mutated custom";
						}
					}
					return fauxAssistantMessage("done");
				},
			]);
			harness.session.refreshContext();
			await harness.session.agent.continue();
			expect(harness.faux.state.callCount).toBe(1);
			const canonical = JSON.stringify(manager.buildSessionProjection().messages);
			expect(canonical).toContain("original system");
			expect(canonical).toContain(kind === "setup" ? "original custom" : "original edited custom");
			expect(canonical).not.toContain("mutated");
		} finally {
			harness.cleanup();
			fs.rmSync(directory, { recursive: true, force: true });
		}
	},
);

it("keeps a faux tool turn and boundary draft independent of archived history size", async () => {
	const visits: number[] = [];
	for (const count of [80, 40_000]) {
		let reads = 0;
		const archived: SessionEntry[] = Array.from({ length: count }, (_, index) => ({
			type: "custom",
			customType: "archived",
			id: `old-${index}`,
			parentId: index ? `old-${index - 1}` : null,
			timestamp: "2026-10-01T00:00:00.000Z",
		}));
		const entries: FileEntry[] = [
			{ type: "session", version: 3, id: "scaling", cwd: "/tmp", timestamp: "2026-10-01T00:00:00.000Z" },
			...archived,
		];
		const manager = SessionManager.inMemory("/tmp", undefined, entries);
		for (const entry of archived) {
			for (const key of ["type", "parentId"] as const) {
				const value = entry[key];
				Object.defineProperty(entry, key, {
					get() {
						reads++;
						return value;
					},
				});
			}
		}
		const kept = manager.appendMessage({ role: "user", content: "retained", timestamp: 1 });
		manager.appendCompaction("summary", kept, 100);
		const harness = await createHarness({
			sessionManager: manager,
			tools: [noop],
			settings: { compaction: { enabled: false }, retry: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("turn_end", () => ({ entries: [{ type: "custom", customType: "boundary", data: true }] }));
					pi.on("turn_end", (event) => {
						expect(event.context.contextMessages.length).toBeGreaterThan(0);
					});
				},
			],
		});
		try {
			const requests: string[] = [];
			harness.setResponses([
				(context) => {
					requests.push(JSON.stringify(context.messages));
					return fauxAssistantMessage(fauxToolCall("noop", {}, { id: "noop-call" }), { stopReason: "toolUse" });
				},
				(context) => {
					requests.push(JSON.stringify(context.messages));
					return fauxAssistantMessage("done");
				},
			]);
			reads = 0;
			await harness.session.prompt("new input");
			for (let i = 0; i < 8; i++) harness.session.getContextUsage();
			visits.push(reads);
			expect(requests).toHaveLength(2);
			expect(
				requests.every(
					(request) =>
						request.includes("retained") && request.includes("summary") && request.includes("new input"),
				),
			).toBe(true);
			expect(requests[1]).toContain("tool result");
			expect(harness.eventsOfType("entry_appended").filter((event) => event.entry.type === "custom")).toHaveLength(
				2,
			);
		} finally {
			harness.cleanup();
		}
	}
	expect(visits[1]).toBe(visits[0]);
	expect(visits[1]).toBeLessThan(100);
});
