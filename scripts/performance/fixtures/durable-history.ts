// Setup and warmup are excluded. Numeric-point reads are compared with the current-point fast path.
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { MemoryStorage } from "/pi-performance-source/packages/durable/src/storage/memory.ts";
import { type DocumentId, ROOT_CONVERSATION_ID, type Seq } from "/pi-performance-source/packages/durable/src/types.ts";
import { witness } from "../proof.mjs";

const populations = (process.argv[2] ?? "32").split(",").map(Number);
const reads = Number(process.argv[3] ?? "10");
assert(populations.every((n) => Number.isSafeInteger(n) && n >= 8));
assert(Number.isSafeInteger(reads) && reads > 0);
for (const revisions of populations) {
	const storage = new MemoryStorage();
	try {
		await storage.commit([{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], context);
		const id = await storage.mintId<DocumentId>();
		await storage.commit(
			[
				{
					type: "document.create",
					record: {
						id,
						kind: "probe.history",
						scope: { kind: "conversation", conversationId: ROOT_CONVERSATION_ID },
						history: "rewindable",
						fork: "asOf",
					},
					content: { kind: "base", version: 1, value: { count: 0 } },
				},
			],
			context,
		);
		let ancientAt: Seq | undefined;
		let recentAt: Seq | undefined;
		for (let count = 1; count <= revisions; count++) {
			recentAt = await storage.commit(
				[
					{
						type: "document.change",
						id,
						content:
							count % 32 === 0
								? { kind: "base", version: 1, value: { count } }
								: { kind: "delta", version: 1, ops: [["s", ["count"], count]] },
					},
				],
				context,
			);
			if (count === 5) ancientAt = recentAt;
		}
		assert(ancientAt !== undefined && recentAt !== undefined);
		for (const [label, at, expected] of [
			["ancient", ancientAt, 5],
			["recent", recentAt, revisions],
			["current", "current", revisions],
		] as const) {
			if (process.argv.includes("--current-only") && label !== "current") continue;
			assert.equal((await storage.document(id, at, context))?.value.count, expected);
			witness(label, { revisions }, (await storage.document(id, at, context))?.value);
			const start = performance.now();
			for (let i = 0; i < reads; i++) assert.equal((await storage.document(id, at, context))?.value.count, expected);
			const ms = performance.now() - start;
			console.log(JSON.stringify({ revisions, reads, label, ms, usPerRead: (ms * 1000) / reads }));
		}
	} finally {
		await storage.close(context);
	}
}
