import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, type ImageContent } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import * as imageProcessing from "../../src/utils/image-process.ts";
import { loadPhoton } from "../../src/utils/photon.ts";
import { createHarness, getMessageText, getUserTexts, type Harness } from "./harness.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function createImage(): Promise<ImageContent> {
	const photon = await loadPhoton();
	if (!photon) throw new Error("Photon is required for the queued-image regression");
	const image = new photon.PhotonImage(new Uint8Array(16 * 16 * 4).fill(255), 16, 16);
	try {
		return { type: "image", data: Buffer.from(image.get_bytes()).toString("base64"), mimeType: "image/png" };
	} finally {
		image.free();
	}
}

async function dimensions(message: AgentMessage | undefined): Promise<number[]> {
	if (message?.role !== "user" || !Array.isArray(message.content)) throw new Error("Expected an image message");
	const image = message.content.find((part) => part.type === "image");
	if (!image) throw new Error("Expected an image attachment");
	const photon = await loadPhoton();
	if (!photon) throw new Error("Photon is required for the queued-image regression");
	const decoded = photon.PhotonImage.new_from_byteslice(Buffer.from(image.data, "base64"));
	try {
		return [decoded.get_width(), decoded.get_height()];
	} finally {
		decoded.free();
	}
}

const strictModel = {
	id: "strict-images",
	input: ["text", "image"] as ("text" | "image")[],
	inputLimits: { images: { resize: { maxWidth: 2, maxHeight: 2 } } },
};

describe("AgentSession queued image normalization", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it.each([
		["direct", "steer"],
		["direct", "followUp"],
		["prompt", "steer"],
		["prompt", "followUp"],
	] as const)("normalizes real images for %s %s delivery and history", async (path, behavior) => {
		const image = await createImage();
		const harness = await createHarness({ models: [strictModel], settings: { compaction: { enabled: false } } });
		harnesses.push(harness);
		const started = deferred();
		const release = deferred();
		let sentImage: AgentMessage | undefined;
		harness.setResponses([
			async () => {
				started.resolve();
				await release.promise;
				return fauxAssistantMessage("first response");
			},
			(context) => {
				sentImage = context.messages.find((message) => getMessageText(message).startsWith("queued image"));
				return fauxAssistantMessage("image response");
			},
		]);
		const run = harness.session.prompt("start");
		await started.promise;
		try {
			if (path === "direct") await harness.session[behavior]("queued image", [image]);
			else await harness.session.prompt("queued image", { images: [image], streamingBehavior: behavior });
			expect(harness.session.pendingInputCount).toBe(0);
			expect(harness.session.pendingMessageCount).toBe(1);
		} finally {
			release.resolve();
			await run;
		}

		expect(await dimensions(sentImage)).toEqual([2, 2]);
		const stored = harness.sessionManager
			.getEntries()
			.flatMap((entry) =>
				entry.type === "message" &&
				entry.message.role === "user" &&
				getMessageText(entry.message).startsWith("queued image")
					? [entry.message]
					: [],
			);
		expect(stored).toHaveLength(1);
		expect(await dimensions(stored[0])).toEqual([2, 2]);
		expect(getMessageText(stored[0])).toContain("original 16x16, displayed at 2x2");
		expect(getUserTexts(harness)).toEqual(["start", getMessageText(stored[0])]);
		expect(harness.session.pendingMessageCount).toBe(0);
		expect(harness.session.hasPendingMessages).toBe(false);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it.each(["steer", "followUp"] as const)(
		"keeps idle %s images in checkpoint queues until a prompt starts",
		async (behavior) => {
			const image = await createImage();
			const processImage = vi.spyOn(imageProcessing, "processImage");
			const harness = await createHarness({ models: [strictModel] });
			harnesses.push(harness);
			await harness.session[behavior]("queued while idle", [image]);
			expect(processImage).not.toHaveBeenCalled();
			expect(harness.session.isIdle).toBe(true);
			expect(harness.faux.state.callCount).toBe(0);
			const saved = harness.session.getCheckpointQueues();
			expect(await dimensions((behavior === "steer" ? saved.steering : saved.followUp)[0])).toEqual([16, 16]);

			const restored = await createHarness({ models: [strictModel] });
			harnesses.push(restored);
			restored.session.restoreCheckpointQueues(saved);
			expect(restored.session.pendingMessageCount).toBe(1);
			expect(restored.faux.state.callCount).toBe(0);
			restored.setResponses([fauxAssistantMessage("done"), fauxAssistantMessage("followed up")]);
			await restored.session.prompt("resume");
			const queued = restored.session.messages.find((message) =>
				getMessageText(message).startsWith("queued while idle"),
			);
			expect(await dimensions(queued)).toEqual([2, 2]);
			expect(processImage).toHaveBeenCalledTimes(1);
			expect(restored.session.pendingMessageCount).toBe(0);
		},
	);

	it.each([
		["direct", "steer"],
		["direct", "followUp"],
		["prompt", "steer"],
		["prompt", "followUp"],
	] as const)("preserves %s %s admission when an input handler outlasts the active run", async (path, behavior) => {
		const image = await createImage();
		const inputEntered = deferred();
		const releaseInput = deferred();
		const responseEntered = deferred();
		const releaseResponse = deferred();
		const processImage = vi
			.spyOn(imageProcessing, "processImage")
			.mockResolvedValue({ ok: true, data: image.data, mimeType: image.mimeType, hints: [] });
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", async (event) => {
						if (event.text !== "later") return;
						inputEntered.resolve();
						await releaseInput.promise;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			async () => {
				responseEntered.resolve();
				await releaseResponse.promise;
				return fauxAssistantMessage("first");
			},
			fauxAssistantMessage("next"),
			fauxAssistantMessage("follow-up"),
		]);
		const run = harness.session.prompt("start");
		await responseEntered.promise;
		const submitted =
			path === "direct"
				? harness.session[behavior]("later", [image])
				: harness.session.prompt("later", { images: [image], streamingBehavior: behavior });
		try {
			await inputEntered.promise;
			expect(harness.session.pendingInputCount).toBe(1);
			releaseResponse.resolve();
			await run;
			expect(harness.session.isIdle).toBe(true);
			expect(processImage).not.toHaveBeenCalled();
			releaseInput.resolve();
			await submitted;
			expect(harness.session.pendingInputCount).toBe(0);
			if (path === "direct") {
				expect(harness.faux.state.callCount).toBe(1);
				expect(harness.session.pendingMessageCount).toBe(1);
				expect(processImage).not.toHaveBeenCalled();
				await harness.session.prompt("resume");
			} else {
				expect(harness.faux.state.callCount).toBe(2);
			}
			expect(getUserTexts(harness)).toEqual(path === "direct" ? ["start", "resume", "later"] : ["start", "later"]);
			expect(processImage).toHaveBeenCalledTimes(1);
			expect(harness.session.pendingMessageCount).toBe(0);
		} finally {
			releaseResponse.resolve();
			releaseInput.resolve();
			await run;
			await submitted;
		}
	});

	it("honors imageAutoResize=false, and does not renormalize history after a model change", async () => {
		const image = await createImage();
		const processImage = vi.spyOn(imageProcessing, "processImage");
		const harness = await createHarness({ models: [strictModel], settings: { images: { autoResize: false } } });
		harnesses.push(harness);
		await harness.session.steer("original", [image]);
		harness.setResponses([fauxAssistantMessage("done"), fauxAssistantMessage("done again")]);
		await harness.session.prompt("start");
		const original = harness.session.messages.find(
			(message) => message.role === "user" && getMessageText(message) === "original",
		);
		expect(await dimensions(original)).toEqual([16, 16]);
		expect(original).toMatchObject({ role: "user", content: expect.arrayContaining([image]) });
		harness.settingsManager.setImageAutoResize(true);
		harness.session.agent.state.model = {
			...harness.getModel(),
			inputLimits: { images: { resize: { maxWidth: 1, maxHeight: 1 } } },
		};
		await harness.session.prompt("continue");
		expect(await dimensions(original)).toEqual([16, 16]);
		expect(processImage).toHaveBeenCalledTimes(1);
	});

	it("normalizes input-hook replacements using the model selected before queued delivery", async () => {
		const image = await createImage();
		const replacement = { ...image, mimeType: "image/jpeg" };
		const processImage = vi
			.spyOn(imageProcessing, "processImage")
			.mockResolvedValue({ ok: false, message: "[Image omitted: test conversion failure.]" });
		const input = vi.fn();
		const harness = await createHarness({
			models: [{ id: "wide" }, strictModel],
			extensionFactories: [
				(pi) => {
					pi.on("input", (event) => {
						input(event.text);
						if (event.text === "replace") return { action: "transform", text: "replaced", images: [replacement] };
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			async () => {
				await harness.session.followUp("replace", [image]);
				await harness.session.setModel(harness.getModel("strict-images")!);
				return fauxAssistantMessage("first");
			},
			fauxAssistantMessage("second"),
		]);
		await harness.session.prompt("start");
		expect(processImage).toHaveBeenCalledExactlyOnceWith(Buffer.from(image.data, "base64"), "image/jpeg", {
			autoResizeImages: true,
			resizeOptions: strictModel.inputLimits.images.resize,
		});
		expect(input.mock.calls).toEqual([["start"], ["replace"]]);
		expect(getUserTexts(harness)).toEqual(["start", "replaced\n\n[Image omitted: test conversion failure.]"]);
		const delivered = harness
			.eventsOfType("message_start")
			.filter((event) => event.message.role === "user")
			.at(-1)!;
		expect(delivered).toMatchObject({
			message: {
				role: "user",
				content: [{ type: "text", text: "replaced\n\n[Image omitted: test conversion failure.]" }],
			},
		});
		expect(harness.session.pendingMessageCount).toBe(0);
	});

	it.each([
		["steer", "one-at-a-time"],
		["steer", "all"],
		["followUp", "one-at-a-time"],
		["followUp", "all"],
	] as const)("owns delayed %s image delivery in %s order without orphaning later input", async (behavior, mode) => {
		const image = await createImage();
		const entered = deferred();
		const release = deferred();
		const processImage = vi.spyOn(imageProcessing, "processImage").mockImplementationOnce(async () => {
			entered.resolve();
			await release.promise;
			return { ok: true, data: image.data, mimeType: image.mimeType, hints: ["[normalized]"] };
		});
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.setSteeringMode(mode);
		harness.session.setFollowUpMode(mode);
		const requests: string[][] = [];
		harness.setResponses([
			async () => {
				await harness.session[behavior]("", [image]);
				await harness.session[behavior]("second");
				return fauxAssistantMessage("first");
			},
			...Array.from({ length: 3 }, () => (context: { messages: AgentMessage[] }) => {
				requests.push(context.messages.filter((message) => message.role === "user").map(getMessageText));
				return fauxAssistantMessage("next");
			}),
		]);
		const run = harness.session.prompt("start");
		try {
			await entered.promise;
			expect(harness.session.isStreaming).toBe(true);
			expect(harness.session.isIdle).toBe(false);
			expect(harness.session.pendingInputCount).toBe(0);
			expect(harness.session.pendingMessageCount).toBe(1);
			expect(harness.faux.state.callCount).toBe(1);
			await harness.session.prompt("third", { streamingBehavior: behavior });
			expect(harness.session.pendingMessageCount).toBe(2);
		} finally {
			release.resolve();
			await run;
		}
		expect(requests[0]).toEqual(
			mode === "all" ? ["start", "\n\n[normalized]", "second"] : ["start", "\n\n[normalized]"],
		);
		expect(getUserTexts(harness)).toEqual(["start", "\n\n[normalized]", "second", "third"]);
		expect(harness.faux.state.callCount).toBe(mode === "all" ? 3 : 4);
		expect(processImage).toHaveBeenCalledTimes(1);
		expect(harness.session.pendingMessageCount).toBe(0);
		expect(harness.session.hasPendingMessages).toBe(false);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});

	it.each(["steer", "followUp"] as const)(
		"retains delivered and still-queued %s inputs when aborted during normalization",
		async (behavior) => {
			const image = await createImage();
			const entered = deferred();
			const release = deferred();
			vi.spyOn(imageProcessing, "processImage").mockImplementationOnce(async () => {
				entered.resolve();
				await release.promise;
				return { ok: true, data: image.data, mimeType: image.mimeType, hints: ["[normalized]"] };
			});
			const harness = await createHarness();
			harnesses.push(harness);
			harness.setResponses([
				async () => {
					await harness.session[behavior]("image", [image]);
					await harness.session[behavior]("remaining", [image]);
					return fauxAssistantMessage("first");
				},
				fauxAssistantMessage("must not run"),
			]);
			const run = harness.session.prompt("start");
			let abort: Promise<void> | undefined;
			try {
				await entered.promise;
				abort = harness.session.abort();
				expect(harness.session.isIdle).toBe(false);
				expect(harness.session.pendingMessageCount).toBe(1);
			} finally {
				release.resolve();
				await run;
				await abort;
			}
			expect(harness.faux.state.callCount).toBe(1);
			expect(getUserTexts(harness)).toEqual(["start", "image\n\n[normalized]"]);
			const users = harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "message" && entry.message.role === "user");
			expect(users).toHaveLength(2);
			const queues = harness.session.getCheckpointQueues();
			const remaining = behavior === "steer" ? queues.steering : queues.followUp;
			expect(remaining).toHaveLength(1);
			expect(remaining[0]).toMatchObject({ role: "user", content: expect.arrayContaining([image]) });
			expect(harness.session.clearQueue()).toEqual(
				behavior === "steer"
					? { steering: ["remaining"], followUp: [] }
					: { steering: [], followUp: ["remaining"] },
			);
			expect(harness.session.pendingInputCount).toBe(0);
			expect(harness.session.hasPendingMessages).toBe(false);
		},
	);

	it("waits for normalization before a turn checkpoint and preserves the remaining native queue", async () => {
		const image = await createImage();
		const entered = deferred();
		const release = deferred();
		vi.spyOn(imageProcessing, "processImage").mockImplementationOnce(async () => {
			entered.resolve();
			await release.promise;
			return { ok: true, data: image.data, mimeType: image.mimeType, hints: [] };
		});
		const dir = mkdtempSync(join(tmpdir(), "pi-image-checkpoint-"));
		tempDirs.push(dir);
		const harness = await createHarness({ sessionManager: SessionManager.create(dir, dir) });
		harnesses.push(harness);
		harness.setResponses([
			async () => {
				await harness.session.steer("image", [image]);
				await harness.session.steer("remaining", [image]);
				return fauxAssistantMessage("first");
			},
			fauxAssistantMessage("image delivered"),
			fauxAssistantMessage("remaining delivered"),
		]);
		const run = harness.session.prompt("start");
		try {
			await entered.promise;
			const checkpoint = harness.session.acquireCheckpoint({ boundary: "turn" });
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(harness.session.isCheckpointHeld).toBe(false);
			release.resolve();
			const hold = await checkpoint;
			try {
				expect(harness.faux.state.callCount).toBe(2);
				expect(hold.checkpoint.queues.steering.map(getMessageText)).toEqual(["remaining"]);
				expect(
					hold.checkpoint.entries.filter(
						(entry) => entry.type === "message" && getMessageText(entry.message) === "image",
					),
				).toHaveLength(1);
			} finally {
				hold.release();
			}
		} finally {
			release.resolve();
			harness.session.cancelCheckpoint();
			await run;
		}
		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.session.pendingMessageCount).toBe(0);
	});
});
