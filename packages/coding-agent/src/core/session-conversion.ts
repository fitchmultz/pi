import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { publishLocalFileExclusiveSync } from "@earendil-works/pi-agent-core/node";
import {
	closeJournalSource,
	copyJournalRecord,
	type JournalRecord,
	type JournalReplacement,
	type JournalRewrite,
	type JournalScan,
	type JsonByteSink,
	type JsonPath,
	type JsonProjectionOptions,
	readJournalRecord,
	scanJournal,
	transformJournalRecord,
	verifyJournalSource,
	writeJournalValue,
} from "./session-journal.ts";
import { buildSessionProjection, type SessionEntry } from "./session-manager.ts";

type RecordValue = Record<string, unknown>;

function refuse(reason: string): never {
	throw new Error(
		`Session conversion refused: ${reason}. Original journal is unchanged; do not replay unfinished work.`,
	);
}

function object(value: unknown): RecordValue {
	if (!value || typeof value !== "object" || Array.isArray(value)) refuse("expected a journal object");
	return value as RecordValue;
}

function text(value: unknown): string {
	if (typeof value !== "string" || !value) refuse("missing or invalid string field");
	return value;
}

function array(value: unknown): unknown[] {
	if (!Array.isArray(value)) refuse("expected an array");
	return value;
}

const entryFields = ["checkpoint", "consumedToolResultIds", "concurrentToolResultIds"];
const systemFields = ["contextWindowId", "nativeHead", "replace", "deferredToolEntries"];
const callFields = ["async", "responsesItem", "executionStarted", "executionArguments", "executionDetached", "kind"];
const resultFields = ["namespace", "toolCallKind", "toolsAdded", "executionSkipped", "elapsedMs"];
const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function conversionProjection(): JsonProjectionOptions {
	const roots = new Set([
		"type",
		"version",
		"id",
		"parentId",
		"timestamp",
		"cwd",
		"parentSession",
		"checkpoint",
		"customType",
		"provider",
		"model",
		"modelId",
		"kind",
		"contributionId",
		"note",
		"thinkingLevel",
		"summary",
		"firstKeptEntryId",
		"tokensBefore",
		"fromHook",
		"fromId",
		"targetId",
		"label",
		"name",
		"display",
		"handoff",
		"retainedToolResultIds",
		"consumedToolResultIds",
		"concurrentToolResultIds",
	]);
	const containers = new Set([
		"message",
		"systemMessage",
		"replacement",
		"content",
		"toolsAdded",
		"toolsRemoved",
		"deferredToolEntries",
		"parameters",
		"arguments",
		"executionArguments",
		"usage",
		"cost",
		"deferred",
		"nativeHead",
		"replace",
	]);
	const fields = new Set([
		"type",
		"id",
		"name",
		"role",
		"api",
		"provider",
		"model",
		"responseId",
		"timestamp",
		"stopReason",
		"toolExecutionFailed",
		"toolCallId",
		"toolName",
		"namespace",
		"toolCallKind",
		"isError",
		"executionSkipped",
		"elapsedMs",
		"contextWindowId",
		"executionStarted",
		"executionDetached",
		"async",
		"kind",
		"toolSearch",
		"responsesItem",
		"description",
		"text",
		"thinking",
		"textSignature",
		"thinkingSignature",
		"input",
		"output",
		"cacheRead",
		"cacheWrite",
		"cacheWrite1h",
		"reasoning",
		"totalTokens",
		"total",
	]);
	return {
		select: (path) => {
			if (!path.length) return "descend";
			const key = String(path.at(-1));
			const shape = path.findIndex((part) =>
				[
					"arguments",
					"parameters",
					"executionArguments",
					"responsesItem",
					"deferred",
					"nativeHead",
					"replace",
					"checkpoint",
				].includes(String(part)),
			);
			if (shape >= 0) return shape === path.length - 1 ? "descend" : "skip";
			if (typeof path.at(-1) === "number" || containers.has(key)) return "descend";
			return path.length === 1 ? (roots.has(key) ? "keep" : "skip") : fields.has(key) ? "keep" : "skip";
		},
		stringLimit: (path) =>
			[
				"content",
				"description",
				"text",
				"thinking",
				"textSignature",
				"thinkingSignature",
				"arguments",
				"parameters",
				"executionArguments",
			].includes(String(path.at(-1)))
				? 0
				: [
							"summary",
							"handoff",
							"nativeHead",
							"replace",
							"async",
							"executionStarted",
							"executionDetached",
							"checkpoint",
						].includes(String(path.at(-1)))
					? 1
					: Infinity,
	};
}

function hasFields(value: RecordValue, fields: string[]): boolean {
	return fields.some((key) => Object.hasOwn(value, key));
}

function legacyTools(value: RecordValue): boolean {
	return ["toolsAdded", "toolsRemoved", "deferredToolEntries"].some(
		(key) =>
			Array.isArray(value[key]) &&
			value[key].some(
				(tool: unknown) =>
					tool !== null &&
					typeof tool === "object" &&
					!Array.isArray(tool) &&
					(typeof (tool as RecordValue).namespace === "string" ||
						hasFields(tool as RecordValue, ["async", "toolSearch"])),
			),
	);
}

function legacyContent(value: unknown): boolean {
	if (!Array.isArray(value)) return false;
	return value.some((block) => {
		return (
			block !== null &&
			typeof block === "object" &&
			!Array.isArray(block) &&
			block.type === "toolCall" &&
			hasFields(block, callFields)
		);
	});
}

/** Inspect only retired runtime fields, not arbitrary extension data or fork identity. */
export function assertSessionConversionNotRequired(rawEntries: readonly unknown[]): void {
	for (const raw of rawEntries) {
		const entry = object(raw);
		text(entry.type);
		let required = entry.type === "context_window" || hasFields(entry, entryFields);
		if (entry.type === "custom" && entry.customType === "response-steering") required = true;
		if (entry.systemMessage !== undefined) {
			const system = object(entry.systemMessage);
			required ||= hasFields(system, systemFields) || legacyTools(system);
		}
		if (entry.type === "context_edit" && entry.replacement !== null) {
			const replacement = entry.replacement;
			if (replacement && typeof replacement === "object" && !Array.isArray(replacement))
				required ||= legacyContent((replacement as RecordValue).content);
		}
		if (entry.type === "message") {
			const message = object(entry.message);
			text(message.role);
			if (message.role === "system") required ||= hasFields(message, systemFields) || legacyTools(message);
			if (message.role === "assistant") {
				required ||= legacyContent(message.content);
			}
			if (message.role === "toolResult")
				required ||= hasFields(
					message,
					resultFields.filter((key) => key !== "elapsedMs"),
				);
		}
		if (required) {
			throw new Error(
				"This journal requires one-time conversion. Use pi convert-session SOURCE NEW_PATH; keep the original archive.",
			);
		}
	}
}

/** Convert a settled v3 journal without loading extensions, contacting providers, or executing tools. */
export function convertSessionFile(sourcePath: string, outputPath: string): void {
	if (resolve(sourcePath) === resolve(outputPath)) refuse("source and output must be distinct paths");
	let scan: JournalScan;
	try {
		scan = scanJournal(sourcePath, { ...conversionProjection(), policy: "strict", allowLeadingBom: true });
	} catch (error) {
		refuse(`invalid JSONL: ${String(error)}`);
	}
	try {
		const recordById = new Map(scan.records.map((record) => [record.value.id, record]));
		const records = scan.records.map((record) => record.value);
		let decoded: { record: JournalRecord; key: string; value: unknown } | undefined;
		const field = (record: JournalRecord, path: JsonPath): unknown => {
			const key = JSON.stringify(path);
			if (decoded?.record === record && decoded.key === key) return decoded.value;
			// ponytail: semantic comparisons explicitly request one selected value; unrelated journal bodies stay token-only.
			const raw = readJournalRecord(scan.source, record, (at) => {
				if (at.length <= path.length && at.every((part, index) => part === path[index]))
					return at.length === path.length ? "keep" : "descend";
				return "skip";
			});
			let value: unknown = raw;
			for (const part of path)
				value = value && typeof value === "object" ? (value as Record<string | number, unknown>)[part] : undefined;
			decoded = { record, key, value };
			return value;
		};
		const fullMessage = (id: string): RecordValue => object(field(recordById.get(id)!, ["message"]));
		const callLocations = new WeakMap<object, { record: JournalRecord; index: number }>();
		for (const record of scan.records) {
			const message = record.value.message;
			if (message && typeof message === "object" && !Array.isArray(message)) {
				const content = (message as RecordValue).content;
				if (Array.isArray(content))
					content.forEach((block, index) => {
						if (block && typeof block === "object") callLocations.set(block, { record, index });
					});
			}
			if (record.value.type === "custom" && record.value.customType === "response-steering") {
				const projected = readJournalRecord(scan.source, record, {
					select: (at) =>
						!at.length || (at.length === 1 && at[0] === "data") || (at.length === 2 && at[1] === "message")
							? "descend"
							: at[0] === "data" &&
									["steeringId", "status", "responseId", "role", "timestamp"].includes(String(at.at(-1)))
								? "keep"
								: "skip",
					stringLimit: (at) => (at.at(-1) === "status" ? 16 : at.at(-1) === "message" ? 0 : Infinity),
				});
				record.value.data = projected.data;
			}
		}
		const callArguments = (call: RecordValue): unknown => {
			const location = callLocations.get(call)!;
			return field(location.record, ["message", "content", location.index, "arguments"]);
		};
		const header = records.shift();
		if (!header || header.type !== "session" || header.version !== 3)
			refuse("only version 3 session journals are supported");
		text(header.id);
		text(header.cwd);
		text(header.timestamp);
		const entries = new Map<string, RecordValue>();
		const parents = new Set<string>();
		const allowed = new Set([
			"message",
			"thinking_level_change",
			"model_change",
			"context_window",
			"usage",
			"compaction",
			"branch_summary",
			"custom",
			"custom_message",
			"context_edit",
			"label",
			"session_info",
		]);
		for (const entry of records) {
			const id = text(entry.id);
			if (!Number.isFinite(Date.parse(text(entry.timestamp)))) refuse(`invalid timestamp at ${id}`);
			if (entry.checkpoint !== undefined && typeof entry.checkpoint !== "boolean")
				refuse(`invalid checkpoint at ${id}`);
			if (entry.type === "message") {
				const message = object(entry.message);
				if (
					![
						"system",
						"user",
						"assistant",
						"toolResult",
						"bashExecution",
						"custom",
						"branchSummary",
						"compactionSummary",
					].includes(text(message.role))
				)
					refuse(`unknown message role at ${id}`);
				if (typeof message.timestamp !== "number" || !Number.isFinite(message.timestamp))
					refuse(`invalid message timestamp at ${id}`);
				if (["system", "user", "assistant", "toolResult", "custom"].includes(text(message.role))) {
					if (typeof message.content !== "string") array(message.content).forEach(object);
					if (message.role === "assistant" || message.role === "toolResult") array(message.content);
				}
				if (message.role === "assistant") {
					text(message.api);
					text(message.provider);
					text(message.model);
					object(message.usage);
				}
				if (message.role === "toolResult" && typeof message.isError !== "boolean")
					refuse(`invalid tool result at ${id}`);
			}
			if (entry.type === "compaction") {
				if (
					typeof entry.summary !== "string" ||
					typeof entry.tokensBefore !== "number" ||
					!Number.isFinite(entry.tokensBefore)
				)
					refuse(`invalid compaction at ${id}`);
				text(entry.firstKeptEntryId);
			}
			if (entry.type === "context_edit" || entry.type === "label") text(entry.targetId);
			if (entry.type === "branch_summary") text(entry.fromId);
			if (!allowed.has(text(entry.type)) || entries.has(id)) refuse(`unknown entry type or duplicate id ${id}`);
			if (entry.parentId !== null && !entries.has(text(entry.parentId)))
				refuse(`missing or forward parent for ${id}`);
			entries.set(id, entry);
			if (entry.parentId !== null) parents.add(text(entry.parentId));
		}
		let replayEntries = entries;
		function pathTo(id: string): RecordValue[] {
			const path: RecordValue[] = [];
			let entry = replayEntries.get(id);
			while (entry) {
				path.push(entry);
				entry = entry.parentId === null ? undefined : replayEntries.get(text(entry.parentId));
			}
			return path.reverse();
		}
		for (const entry of records) {
			if (
				![
					"targetId",
					"fromId",
					"firstKeptEntryId",
					"retainedToolResultIds",
					"consumedToolResultIds",
					"concurrentToolResultIds",
				].some((key) => entry[key] !== undefined)
			)
				continue;
			const path = pathTo(text(entry.id));
			for (const key of ["targetId", "fromId", "firstKeptEntryId"]) {
				if (entry[key] === undefined) continue;
				const reference = text(entry[key]);
				if (
					!entries.has(reference) &&
					!(key === "fromId" && entry.type === "branch_summary" && reference === "root")
				)
					refuse(`dangling ${key} at ${entry.id}`);
				if (
					(key === "firstKeptEntryId" || (key === "targetId" && entry.type === "context_edit")) &&
					!path.some((item) => item.id === reference)
				)
					refuse(`off-branch ${key} at ${entry.id}`);
			}
			for (const key of ["retainedToolResultIds", "consumedToolResultIds", "concurrentToolResultIds"]) {
				if (entry[key] === undefined) continue;
				if (
					key !== "retainedToolResultIds" &&
					(entry.type !== "message" || object(entry.message).role !== "assistant")
				)
					refuse(`invalid ${key} at ${entry.id}`);
				for (const reference of array(entry[key])) {
					const target = path.find((item) => item.id === reference);
					if (!target || target.type !== "message" || object(target.message).role !== "toolResult")
						refuse(`invalid ${key} at ${entry.id}`);
				}
			}
		}

		// Resolve each response independently on every leaf. A shared snapshot must not
		// acquire a final response that exists only on a different branch.
		const finalByFirst = new Map<string, string>();
		const selectedMessage = (entry: RecordValue): RecordValue =>
			object(entries.get(finalByFirst.get(text(entry.id)) ?? text(entry.id))!.message);
		const redundant = new Set<string>();
		const firstByFrame = new Map<string, string>();
		for (const leaf of entries.keys()) {
			if (parents.has(leaf)) continue;
			const path = pathTo(leaf);
			const responses = new Map<string, RecordValue[]>();
			const calls = new Map<string, RecordValue>();
			const results = new Map<string, RecordValue>();
			const steering = new Map<string, RecordValue>();
			for (const entry of path) {
				if (entry.type === "custom" && entry.customType === "response-steering") {
					const data = object(entry.data);
					if (!["queued", "accepted", "applied", "failed", "unknown"].includes(text(data.status)))
						refuse(`invalid steering status at ${entry.id}`);
					if (data.steeringId === undefined && data.status !== "queued")
						refuse(`missing steering identity at ${entry.id}`);
					const key = JSON.stringify([data.steeringId === undefined, data.steeringId ?? entry.id]);
					if (data.steeringId !== undefined) text(data.steeringId);
					const previous = steering.get(key);
					if (previous) {
						const prior = object(previous.data);
						for (const key of ["message", "responseId"])
							if (
								prior[key] !== undefined &&
								data[key] !== undefined &&
								!isDeepStrictEqual(
									field(recordById.get(previous.id)!, ["data", key]),
									field(recordById.get(entry.id)!, ["data", key]),
								)
							)
								refuse(`conflicting steering ${key} at ${entry.id}`);
					}
					steering.set(key, entry);
				}
				if (entry.type !== "message") continue;
				const message = object(entry.message);
				if (message.role === "assistant") {
					array(message.content);
					if (message.deferred !== undefined || message.stopReason === "deferred")
						refuse(`deferred response at ${entry.id}`);
					if (message.responseId !== undefined) {
						const key = JSON.stringify([message.provider, message.api, message.model, text(message.responseId)]);
						const frames = responses.get(key) ?? [];
						frames.push(entry);
						responses.set(key, frames);
					} else if (entry.checkpoint || message.stopReason === "pending")
						refuse(`unfinished response at ${entry.id}`);
				}
				if (message.role === "toolResult") {
					const id = text(message.toolCallId);
					if (results.has(id)) refuse(`duplicate tool result ${id}`);
					results.set(id, message);
				}
			}
			for (const event of steering.values()) {
				const data = object(event.data);
				if (data.status === "failed") continue;
				const deliveries = path.filter(
					(entry) =>
						entry.type === "message" &&
						object(entry.message).role === "user" &&
						isDeepStrictEqual(fullMessage(text(entry.id)), field(recordById.get(event.id)!, ["data", "message"])),
				);
				if (deliveries.length !== 1) refuse(`steering input is not journaled exactly once on branch ${leaf}`);
				if (data.status === "applied") continue;
				const position = path.indexOf(deliveries[0]);
				if (
					typeof data.responseId !== "string" ||
					!data.responseId ||
					position <= path.indexOf(event) ||
					!path.slice(position + 1).some((entry) => {
						if (entry.type !== "message" || entry.checkpoint) return false;
						const message = object(entry.message);
						return (
							message.role === "assistant" &&
							typeof message.responseId === "string" &&
							message.responseId !== data.responseId &&
							["stop", "length", "toolUse", "error", "aborted"].includes(String(message.stopReason))
						);
					})
				)
					refuse(`unsettled steering on branch ${leaf}`);
			}
			for (const frames of responses.values()) {
				const finals = frames.filter(
					(entry) => !entry.checkpoint && object(entry.message).stopReason !== "pending",
				);
				if (finals.length !== 1)
					refuse(`response at ${frames[0].id} has no unique final snapshot on branch ${leaf}`);
				const final = object(finals[0].message);
				const finalCalls = new Map(
					array(final.content)
						.map(object)
						.filter((block) => block.type === "toolCall")
						.map((call) => [text(call.id), call]),
				);
				for (const frame of frames) {
					for (const call of array(object(frame.message).content).map(object)) {
						if (call.type !== "toolCall") continue;
						const settled = finalCalls.get(text(call.id));
						if (
							!settled ||
							call.name !== settled.name ||
							call.namespace !== settled.namespace ||
							(call !== settled && !isDeepStrictEqual(callArguments(call), callArguments(settled)))
						)
							refuse(`conflicting or lost call ${call.id}`);
						if (call.executionArguments !== undefined) object(call.executionArguments);
					}
				}
				const first = text(frames[0].id);
				const prior = finalByFirst.get(first);
				const finalId = text(finals[0].id);
				if (prior && prior !== finalId && !isDeepStrictEqual(fullMessage(prior), fullMessage(finalId)))
					refuse(`branch-dependent final snapshot at ${first}`);
				finalByFirst.set(first, finalId);
				if (frames.length > 1) for (const frame of frames) firstByFrame.set(text(frame.id), first);
				for (const frame of frames.slice(1)) redundant.add(text(frame.id));
			}
			for (const entry of path) {
				if (entry.type !== "message" || redundant.has(text(entry.id))) continue;
				const message = selectedMessage(entry);
				if (message.role !== "assistant") continue;
				if (!["stop", "length", "toolUse", "error", "aborted"].includes(text(message.stopReason)))
					refuse(`unfinished response at ${entry.id}`);
				for (const call of array(message.content).map(object)) {
					if (call.type !== "toolCall") continue;
					const id = text(call.id);
					if (calls.has(id)) refuse(`duplicate call ${id}`);
					object(call.arguments);
					calls.set(id, call);
					const result = results.get(id);
					if (!result || result.toolName !== call.name || result.namespace !== call.namespace)
						refuse(`missing or mismatched result for ${id} on branch ${leaf}`);
					if (path.findIndex((item) => item.type === "message" && item.message === result) <= path.indexOf(entry))
						refuse(`result ${id} precedes its call`);
				}
			}
			for (const id of results.keys()) if (!calls.has(id)) refuse(`orphan result ${id} on branch ${leaf}`);
		}

		let ordered = records;
		if (
			records.some(
				(entry) => entry.concurrentToolResultIds !== undefined && array(entry.concurrentToolResultIds).length,
			)
		) {
			// ponytail: causal reparenting supports one linear history, within each boundary.
			// Branch-dependent or cross-boundary ordering needs a separate representability proof.
			if (records.some((entry, index) => entry.parentId !== (index === 0 ? null : records[index - 1].id)))
				refuse("causal receipt ordering on a branched journal requires context reconstruction");
			const positions = new Map(records.map((entry, index) => [entry.id, index]));
			const after = new Map<string, number>();
			let boundary = -1;
			for (const [index, entry] of records.entries()) {
				if (entry.type === "compaction" || entry.type === "context_window" || entry.type === "context_edit")
					boundary = index;
				if (entry.type !== "message" || object(entry.message).role !== "assistant" || redundant.has(text(entry.id)))
					continue;
				// Legacy coalescing keeps the first frame's concurrent receipts, not later checkpoints' lists.
				for (const id of entry.concurrentToolResultIds === undefined ? [] : array(entry.concurrentToolResultIds)) {
					const position = positions.get(text(id))!;
					if (position >= index) continue;
					if (position < boundary) refuse(`causal receipt ${id} crosses a boundary at ${entry.id}`);
					after.set(text(id), index);
				}
			}
			const deferred = new Map<number, RecordValue[]>();
			for (const entry of records) {
				const index = after.get(text(entry.id));
				if (index === undefined) continue;
				const receipts = deferred.get(index) ?? [];
				receipts.push(entry);
				deferred.set(index, receipts);
			}
			ordered = [];
			for (const [index, entry] of records.entries()) {
				if (!after.has(text(entry.id))) ordered.push(entry);
				ordered.push(...(deferred.get(index) ?? []));
			}
			ordered = ordered.map((entry, index) => ({ ...entry, parentId: index === 0 ? null : ordered[index - 1].id }));
			replayEntries = new Map(ordered.map((entry) => [text(entry.id), entry]));
		}

		// Receipt moves can change both compaction retention and the final leaf.
		const replayParents = new Set(ordered.map((entry) => entry.parentId));
		for (const leaf of replayEntries.keys()) {
			if (replayParents.has(leaf)) continue;
			const path = pathTo(leaf);
			const resultPositions = new Map<string, number>();
			for (const [index, entry] of path.entries())
				if (entry.type === "message" && object(entry.message).role === "toolResult")
					resultPositions.set(text(object(entry.message).toolCallId), index);
			for (const [callPosition, entry] of path.entries()) {
				if (entry.type !== "message" || redundant.has(text(entry.id))) continue;
				const message = selectedMessage(entry);
				if (message.role !== "assistant") continue;
				for (const call of array(message.content).map(object)) {
					if (call.type !== "toolCall") continue;
					const id = text(call.id);
					const resultPosition = resultPositions.get(id)!;
					for (const boundary of path.slice(callPosition + 1)) {
						if (boundary.type !== "context_window" && boundary.type !== "compaction") continue;
						const position = path.indexOf(boundary);
						const kept = firstByFrame.get(String(boundary.firstKeptEntryId)) ?? boundary.firstKeptEntryId;
						const keptPosition = path.findIndex((item) => item.id === kept);
						const resultRetained =
							resultPosition > position ||
							(boundary.type === "compaction" && keptPosition >= 0 && resultPosition >= keptPosition);
						const callRetained =
							boundary.type === "compaction" && keptPosition >= 0 && callPosition >= keptPosition;
						if (resultRetained && !callRetained && !(boundary.type === "context_window" && call.async === true))
							refuse(
								`boundary ${boundary.id} carries result ${id} without its original call; requires context reconstruction`,
							);
					}
				}
			}
		}

		const blockSources = new WeakMap<
			RecordValue,
			{ record: JournalRecord; index: number; blankThinking?: boolean }
		>();
		const carriedSources = new WeakMap<
			RecordValue,
			{ record: JournalRecord; content?: RecordValue[]; receipt?: boolean }
		>();
		const declarationSources = new WeakMap<RecordValue, JournalRecord>();
		const identities = new Map<string, { namespace: string | null; name: string }>();
		const names = new Map<string, Set<string>>();
		function identity(value: unknown, result = false): void {
			const item = object(value);
			const name = text(item[result ? "toolName" : "name"]);
			const namespace = item.namespace;
			if (namespace !== undefined && typeof namespace !== "string") refuse(`invalid legacy namespace for ${name}`);
			const key = JSON.stringify([namespace ?? null, name]);
			identities.set(key, { namespace: namespace ?? null, name });
			const keys = names.get(name) ?? new Set<string>();
			keys.add(key);
			names.set(name, keys);
		}
		for (const entry of records) {
			const message = entry.type === "message" ? object(entry.message) : undefined;
			for (const state of [
				message?.role === "system" || message?.role === "toolResult" ? message : undefined,
				entry.systemMessage,
			]) {
				if (!state) continue;
				for (const key of ["toolsAdded", "toolsRemoved", "deferredToolEntries"])
					if (object(state)[key] !== undefined)
						for (const item of array(object(state)[key]))
							identity(typeof item === "string" ? { name: item } : item);
			}
			if (message?.role === "assistant")
				for (const block of array(message.content).map(object)) if (block.type === "toolCall") identity(block);
			if (message?.role === "toolResult") identity(message, true);
		}
		const aliases = new Map<string, string>();
		const usedNames = new Set(names.keys());
		const aliasMetadata: RecordValue[] = [];
		for (const key of [...identities.keys()].sort()) {
			const item = identities.get(key)!;
			let name = item.name;
			if (names.get(name)!.size > 1) {
				const base = `legacy_${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
				name = base;
				for (let suffix = 1; usedNames.has(name); suffix++) name = `${base}_${suffix}`;
				usedNames.add(name);
				aliasMetadata.push({ ...item, convertedName: name });
			}
			aliases.set(key, name);
		}
		function tool(value: unknown, result = false): RecordValue {
			const item = object(value);
			const converted = { ...item };
			converted[result ? "toolName" : "name"] = aliases.get(
				JSON.stringify([item.namespace ?? null, item[result ? "toolName" : "name"]]),
			)!;
			for (const key of [...callFields, ...resultFields, "toolSearch"]) delete converted[key];
			const source = callLocations.get(item);
			if (source) blockSources.set(converted, source);
			return converted;
		}
		function committedContent(message: RecordValue): RecordValue[] {
			const content = array(message.content)
				.map(object)
				.filter(
					(block) =>
						block.type === "toolCall" ||
						(block.type === "text" && block.textSignature !== undefined) ||
						(block.type === "thinking" && block.thinkingSignature !== undefined),
				);
			while (content.at(-1)?.type === "thinking") content.pop();
			for (const block of content) {
				const location = callLocations.get(block)!;
				const root: JsonPath = ["message", "content", location.index];
				if (block.type !== "toolCall") {
					const signature = text(
						field(location.record, [...root, block.type === "text" ? "textSignature" : "thinkingSignature"]),
					);
					if (block.type === "thinking" && String(message.api).endsWith("responses")) {
						let item: RecordValue;
						try {
							item = object(JSON.parse(signature));
						} catch {
							refuse("invalid committed reasoning signature");
						}
						if (
							item.type !== "reasoning" ||
							!Array.isArray(item.summary) ||
							(item.status !== undefined && item.status !== "completed")
						)
							refuse("invalid committed reasoning signature");
						text(item.id);
					}
					continue;
				}
				if (block.responsesItem !== undefined) {
					const item = object(field(location.record, [...root, "responsesItem"]));
					const [callId, itemId] = text(block.id).split("|");
					let argumentsMatch = false;
					if (item.type === "function_call" && typeof item.arguments === "string") {
						try {
							argumentsMatch = isDeepStrictEqual(JSON.parse(item.arguments), callArguments(block));
						} catch {
							// Invalid authoritative arguments cannot prove a completed call.
						}
					} else if (item.type === "custom_tool_call") {
						argumentsMatch = isDeepStrictEqual(Object.values(object(callArguments(block))), [item.input]);
					}
					if (
						!argumentsMatch ||
						item.call_id !== callId ||
						(itemId !== undefined && item.id !== itemId) ||
						item.name !== block.name ||
						item.namespace !== block.namespace ||
						(item.status !== undefined && item.status !== "completed")
					)
						refuse(`invalid committed item for interrupted call ${block.id}`);
				} else if (block.executionStarted !== true)
					refuse(`interrupted call ${block.id} has no committed output proof`);
				if (block.executionArguments !== undefined) object(block.executionArguments);
			}
			return content;
		}
		function system(value: unknown, baseline: boolean): RecordValue {
			const message = object(value);
			if (message.role !== "system") refuse("invalid system checkpoint");
			if (typeof message.timestamp !== "number" || !Number.isFinite(message.timestamp))
				refuse("invalid system checkpoint timestamp");
			if (typeof message.content !== "string") {
				for (const block of array(message.content).map(object))
					if (block.type !== "text" || typeof block.text !== "string") refuse("invalid system checkpoint content");
			}
			if (!baseline && (message.replace || message.nativeHead))
				refuse("mid-history system replacement requires context reconstruction");
			const converted = { ...message };
			if (message.deferredToolEntries !== undefined)
				for (const item of array(message.deferredToolEntries)) tool(item);
			for (const key of systemFields) delete converted[key];
			for (const key of ["toolsAdded", "toolsRemoved"]) {
				if (message[key] !== undefined)
					converted[key] = array(message[key]).map((item) => {
						const definition = tool(key === "toolsRemoved" && typeof item === "string" ? { name: item } : item);
						if (key === "toolsAdded") {
							if (typeof definition.description !== "string") refuse("invalid tool description");
							object(definition.parameters);
						}
						return definition;
					});
			}
			return converted;
		}
		const tails = new Map<string, string>();
		function* convertedEntries(): Generator<RecordValue> {
			for (const [index, entry] of ordered.entries()) {
				const copy = { ...entry };
				if (copy.parentId !== null) copy.parentId = tails.get(text(copy.parentId)) ?? copy.parentId;
				const metadata: RecordValue = {};
				const prefix: RecordValue[] = [];
				const suffix: RecordValue[] = [];
				const original = entries.get(text(entry.id))!;
				if (original.parentId !== entry.parentId) metadata.originalParentId = original.parentId;
				for (const key of entryFields) if (key in original) metadata[key] = original[key];
				if (firstByFrame.get(text(entry.id)) === entry.id) metadata.originalSnapshot = original;
				if (index === 0 && aliasMetadata.length) {
					const id = randomUUID();
					prefix.push({
						type: "custom",
						id,
						parentId: copy.parentId,
						timestamp: entry.timestamp,
						customType: "legacy-conversion-tool-aliases",
						data: aliasMetadata,
					});
					copy.parentId = id;
				}
				if (entry.type === "compaction") {
					const kept = text(entry.firstKeptEntryId);
					copy.firstKeptEntryId = firstByFrame.get(kept) ?? kept;
					const path = pathTo(text(entry.id));
					const window = path.findLastIndex((item) => item.type === "context_window");
					if (window >= 0 && path.findIndex((item) => item.id === copy.firstKeptEntryId) <= window)
						refuse(`compaction ${entry.id} retains history outside its window`);
				}
				for (const key of entryFields) delete copy[key];
				if (entry.type === "custom" && entry.customType === "response-steering")
					copy.customType = "legacy-conversion-steering";
				if (entry.type === "context_window") {
					if (entry.handoff !== undefined && typeof entry.handoff !== "string")
						refuse(`invalid handoff at ${entry.id}`);
					if (entry.tokensBefore !== null && (typeof entry.tokensBefore !== "number" || entry.tokensBefore < 0))
						refuse(`invalid tokensBefore at ${entry.id}`);
					copy.type = "compaction";
					copy.summary = `Context window ${entry.id} starts here. Earlier conversation is not available in this window.`;
					copy.firstKeptEntryId = entry.id;
					copy.tokensBefore = entry.tokensBefore ?? 0;
					copy.fromHook = true;
					copy.details = { legacyConversion: { tokensBefore: entry.tokensBefore } };
					const retained = new Set(
						entry.retainedToolResultIds === undefined ? [] : array(entry.retainedToolResultIds),
					);
					const path = pathTo(text(entry.id));
					const receipts = path.filter((item) => retained.has(item.id));
					const callIds = new Set(receipts.map((item) => text(object(item.message).toolCallId)));
					const arrived = new Set(
						path
							.filter((item) => item.type === "message" && object(item.message).role === "toolResult")
							.map((item) => text(object(item.message).toolCallId)),
					);
					for (const source of path) {
						if (source.type !== "message" || redundant.has(text(source.id))) continue;
						const message = selectedMessage(source);
						if (message.role !== "assistant") continue;
						for (const block of array(message.content).map(object))
							if (block.type === "toolCall" && block.async === true && !arrived.has(text(block.id)))
								callIds.add(text(block.id));
					}
					if (callIds.size) {
						const copiedCalls = new Set<string>();
						for (const source of path) {
							if (source.type !== "message" || redundant.has(text(source.id))) continue;
							const message = selectedMessage(source);
							if (message.role !== "assistant") continue;
							const content: RecordValue[] = [];
							let reasoning: RecordValue[] = [];
							let previousThinking = false;
							const blocks = ["error", "aborted"].includes(String(message.stopReason))
								? committedContent(message)
								: array(message.content).map(object);
							for (const block of blocks) {
								if (block.type === "thinking") {
									if (!previousThinking) reasoning = [];
									const blanked = { ...block, thinking: "" };
									blockSources.set(blanked, { ...callLocations.get(block)!, blankThinking: true });
									reasoning.push(blanked);
								} else if (block.type === "toolCall" && callIds.has(text(block.id))) {
									if (!block.async) refuse(`window ${entry.id} retains a non-async call ${block.id}`);
									content.push(...reasoning, tool(block));
									reasoning = [];
									copiedCalls.add(text(block.id));
								}
								previousThinking = block.type === "thinking";
							}
							if (!content.length) continue;
							if (
								path.some(
									(item) =>
										item.type === "context_edit" &&
										(item.targetId === source.id || retained.has(item.targetId)),
								)
							)
								refuse(`window ${entry.id} retains edited execution history`);
							const carried: RecordValue = { ...message, content, stopReason: "toolUse", usage: zeroUsage };
							delete carried.toolExecutionFailed;
							delete carried.errorMessage;
							const carriedEntry: RecordValue = {
								type: "message",
								id: randomUUID(),
								parentId: prefix.at(-1)?.id ?? copy.parentId,
								timestamp: source.timestamp,
								message: carried,
							};
							carriedSources.set(carriedEntry, {
								record: recordById.get(finalByFirst.get(text(source.id)) ?? text(source.id))!,
								content,
							});
							prefix.push(carriedEntry);
						}
						if (copiedCalls.size !== callIds.size) refuse(`window ${entry.id} has missing retained calls`);
						for (const receipt of receipts) {
							const message = tool(object(receipt.message), true);
							delete message.usage;
							const carriedEntry: RecordValue = {
								type: "message",
								id: randomUUID(),
								parentId: prefix.at(-1)?.id ?? copy.parentId,
								timestamp: receipt.timestamp,
								message,
							};
							carriedSources.set(carriedEntry, { record: recordById.get(receipt.id)!, receipt: true });
							prefix.push(carriedEntry);
						}
						copy.firstKeptEntryId = prefix[0].id;
						copy.parentId = prefix.at(-1)!.id;
					}
					delete copy.handoff;
					delete copy.retainedToolResultIds;
				}
				if (entry.systemMessage !== undefined) {
					copy.systemMessage = system(entry.systemMessage, true);
					metadata.system = Object.fromEntries(
						systemFields
							.filter((key) => key in object(entry.systemMessage))
							.map((key) => [key, object(entry.systemMessage)[key]]),
					);
				}
				if (entry.type === "message") {
					if (redundant.has(text(entry.id))) {
						yield {
							type: "custom",
							id: entry.id,
							parentId: copy.parentId,
							timestamp: entry.timestamp,
							customType: "legacy-conversion-snapshot",
							data: { original },
						};
						continue;
					}
					const message = { ...selectedMessage(entry) };
					if (message.role === "system") {
						const earlier = pathTo(text(entry.id))
							.slice(0, -1)
							.some((item) => item.type === "message" && object(item.message).role === "system");
						if (
							message.nativeHead &&
							pathTo(text(entry.id))
								.slice(0, -1)
								.some((item) => item.type === "message" && object(item.message).role !== "system")
						)
							refuse(`native system anchor ${entry.id} would reorder earlier conversation`);
						copy.message = system(message, !earlier);
						metadata.system = Object.fromEntries(
							systemFields.filter((key) => key in message).map((key) => [key, message[key]]),
						);
					} else if (message.role === "assistant") {
						if (
							["error", "aborted"].includes(String(message.stopReason)) &&
							array(message.content).some((block) => object(block).type === "toolCall")
						) {
							const content = committedContent(message).map((block) =>
								block.type === "toolCall" ? tool(block) : block,
							);
							const replay: RecordValue = { ...message, content, stopReason: "toolUse", usage: zeroUsage };
							delete replay.errorMessage;
							delete replay.toolExecutionFailed;
							metadata.originalSnapshot = original;
							const replayEntry: RecordValue = {
								type: "message",
								id: randomUUID(),
								parentId: entry.id,
								timestamp: entry.timestamp,
								message: replay,
							};
							carriedSources.set(replayEntry, {
								record: recordById.get(finalByFirst.get(text(entry.id)) ?? text(entry.id))!,
								content,
							});
							suffix.push(replayEntry);
						}
						message.content = array(message.content).map((block) =>
							object(block).type === "toolCall" ? tool(block) : block,
						);
						if ("toolExecutionFailed" in message) metadata.toolExecutionFailed = message.toolExecutionFailed;
						delete message.toolExecutionFailed;
						copy.message = message;
					} else if (message.role === "toolResult") {
						if (message.toolsAdded !== undefined) {
							metadata.toolsAdded = message.toolsAdded;
							if (array(message.toolsAdded).length) {
								const declaration: RecordValue = {
									type: "message",
									id: randomUUID(),
									parentId: entry.id,
									timestamp: entry.timestamp,
									message: system(
										{
											role: "system",
											content: "",
											timestamp: message.timestamp,
											toolsAdded: message.toolsAdded,
										},
										false,
									),
								};
								declarationSources.set(declaration, recordById.get(entry.id)!);
								suffix.push(declaration);
							}
						}
						copy.message = tool(message, true);
						for (const key of ["elapsedMs", "executionSkipped"]) if (key in message) metadata[key] = message[key];
					} else copy.message = message;
				}
				if (entry.type === "context_edit") {
					const target = text(entry.targetId);
					const path = pathTo(text(entry.id));
					const boundary = path.findLastIndex(
						(item) => item.type === "compaction" || item.type === "context_window",
					);
					if (firstByFrame.has(target) || path.findIndex((item) => item.id === target) < boundary)
						refuse(`context edit ${entry.id} targets a coalesced response or earlier context boundary`);
					const targetEntry = entries.get(target)!;
					const targetMessage = targetEntry.type === "message" ? object(targetEntry.message) : undefined;
					if (
						targetMessage?.role === "assistant" &&
						array(targetMessage.content).some(
							(block) =>
								object(block).type === "toolCall" &&
								(object(block).async === true ||
									["error", "aborted"].includes(String(targetMessage.stopReason))),
						)
					)
						refuse(`context edit ${entry.id} changes legacy execution history`);
					if (
						entry.replacement === null &&
						targetEntry.type === "message" &&
						object(targetEntry.message).role === "toolResult"
					)
						refuse(`context edit ${entry.id} omits an execution receipt`);
					if (entry.replacement !== null && legacyContent(object(entry.replacement).content))
						refuse(`legacy call edit at ${entry.id}`);
				}
				if (metadata.system && Object.keys(object(metadata.system)).length === 0) delete metadata.system;
				if (suffix.length) tails.set(text(entry.id), text(suffix.at(-1)!.id));
				yield* prefix;
				if (Object.keys(metadata).length) {
					const id = randomUUID();
					const parentId = copy.parentId;
					copy.parentId = id;
					yield {
						type: "custom",
						id,
						parentId,
						timestamp: entry.timestamp,
						customType: "legacy-conversion-metadata",
						data: { sourceEntryId: entry.id, ...metadata },
					};
				}
				yield copy;
				yield* suffix;
			}
		}
		// Only token projections and source locations are retained for grouping; no historical bodies are collected.
		let converted = Array.from(convertedEntries());
		replayEntries = new Map(converted.map((entry) => [text(entry.id), entry]));
		const children = new Map<string, number>();
		const groups = new Map<string, RecordValue[]>();
		const ownerByReceipt = new Map<string, string>();
		for (const entry of converted) {
			if (entry.parentId !== null) {
				const parentId = text(entry.parentId);
				children.set(parentId, (children.get(parentId) ?? 0) + 1);
			}
			if (entry.type !== "message" || object(entry.message).role !== "toolResult") continue;
			const callId = object(entry.message).toolCallId;
			const owner = pathTo(text(entry.id)).findLast((ancestor) => {
				if (ancestor.type !== "message") return false;
				const message = object(ancestor.message);
				return (
					message.role === "assistant" &&
					!["error", "aborted"].includes(String(message.stopReason)) &&
					array(message.content).some((block) => object(block).type === "toolCall" && object(block).id === callId)
				);
			});
			if (!owner) refuse(`no native ancestor call for receipt ${entry.id}`);
			const id = text(owner.id);
			const receipts = groups.get(id) ?? [];
			receipts.push(entry);
			groups.set(id, receipts);
			ownerByReceipt.set(text(entry.id), id);
		}
		const relocated = new Map<string, RecordValue[]>();
		for (const [ownerId, receipts] of groups) {
			const owner = replayEntries.get(ownerId)!;
			const callIds = array(object(owner.message).content)
				.map(object)
				.filter((block) => block.type === "toolCall")
				.map((block) => block.id);
			function alreadyGrouped(group: RecordValue[]): boolean {
				const path = pathTo(text(group.at(-1)!.id));
				return isDeepStrictEqual(
					path
						.slice(path.indexOf(owner) + 1)
						.filter((entry) =>
							entry.type === "message"
								? object(entry.message).role !== "system"
								: ["compaction", "branch_summary", "custom_message"].includes(String(entry.type)),
						)
						.map((entry) => entry.id),
					group.map((entry) => entry.id),
				);
			}
			const byCall = new Map(receipts.map((entry) => [object(entry.message).toolCallId, entry]));
			if (byCall.size !== receipts.length) {
				// Ordinary branches with already-complete groups need no shared receipt relocation.
				for (const receipt of receipts) {
					const group = pathTo(text(receipt.id)).filter((entry) => ownerByReceipt.get(text(entry.id)) === ownerId);
					if (
						alreadyGrouped(group) &&
						isDeepStrictEqual(
							group.map((entry) => object(entry.message).toolCallId),
							callIds.slice(0, group.length),
						)
					)
						continue;
					refuse(`branch-dependent native receipt relocation at ${ownerId}`);
				}
				continue;
			}
			const group: RecordValue[] = [];
			for (const id of callIds) if (byCall.has(id)) group.push(byCall.get(id)!);
			if (alreadyGrouped(group)) continue;
			// ponytail: relocate through one unambiguous path; branch-specific receipts need a separate conversion proof.
			const path = pathTo(text(receipts.at(-1)!.id));
			for (const entry of path.slice(path.indexOf(owner), -1))
				if ((children.get(text(entry.id)) ?? 0) > 1) refuse(`branched native receipt relocation at ${ownerId}`);
			relocated.set(ownerId, group);
		}
		if (relocated.size) {
			const tips = converted.filter((entry) => !children.has(text(entry.id))).map((entry) => text(entry.id));
			function contributions(list: RecordValue[], tip: string, index: Map<string, RecordValue>): Set<string> {
				return new Set(
					buildSessionProjection(
						list as unknown as SessionEntry[],
						tip,
						index as unknown as Map<string, SessionEntry>,
					)
						.entries.filter((entry) => entry.messages.length)
						.map((entry) => entry.sourceEntry.id),
				);
			}
			const retained = new Map(tips.map((tip) => [tip, contributions(converted, tip, replayEntries)]));
			const oldSlots = new Map<string, string | null>();
			const anchors = new Map<string, RecordValue>();
			const moved = new Set<string>();
			for (const group of relocated.values()) for (const entry of group) moved.add(text(entry.id));
			for (const id of moved) {
				const receipt = replayEntries.get(id)!;
				const parent = receipt.parentId === null ? undefined : replayEntries.get(text(receipt.parentId));
				if (!entries.has(id)) {
					oldSlots.set(id, receipt.parentId as string | null);
					continue;
				}
				const anchor =
					parent?.customType === "legacy-conversion-metadata" && object(parent.data).sourceEntryId === id
						? parent
						: {
								type: "custom",
								id: randomUUID(),
								parentId: receipt.parentId,
								timestamp: receipt.timestamp,
								customType: "legacy-conversion-metadata",
								data: { sourceEntryId: id },
							};
				object(anchor.data).originalParentId = entries.get(id)!.parentId;
				oldSlots.set(id, text(anchor.id));
				if (anchor !== parent) anchors.set(id, anchor);
			}
			function stateTail(id: string | null): string | null {
				if (id === null) return null;
				if (oldSlots.has(id)) return stateTail(oldSlots.get(id)!);
				return (relocated.get(id)?.at(-1)?.id as string | undefined) ?? id;
			}
			const groupParents = new Map<string, string>();
			for (const [owner, group] of relocated)
				for (const [index, receipt] of group.entries())
					groupParents.set(text(receipt.id), index === 0 ? owner : text(group[index - 1].id));
			const regrouped: RecordValue[] = [];
			for (const entry of converted) {
				if (moved.has(text(entry.id))) {
					if (anchors.has(text(entry.id))) regrouped.push(anchors.get(text(entry.id))!);
				} else {
					regrouped.push(entry);
					regrouped.push(...(relocated.get(text(entry.id)) ?? []));
				}
			}
			converted = regrouped;
			const referenceMetadata = new Map<unknown, RecordValue>();
			for (const entry of converted) {
				entry.parentId = groupParents.get(text(entry.id)) ?? stateTail(entry.parentId as string | null);
				if (entry.type === "branch_summary" && oldSlots.has(text(entry.fromId))) {
					const fromId = text(entry.fromId);
					entry.fromId = tails.get(fromId) ?? stateTail(fromId);
					const id = randomUUID();
					referenceMetadata.set(entry.id, {
						type: "custom",
						id,
						parentId: entry.parentId,
						timestamp: entry.timestamp,
						customType: "legacy-conversion-metadata",
						data: { sourceEntryId: entry.id, originalFromId: fromId },
					});
					entry.parentId = id;
				}
			}
			if (referenceMetadata.size) {
				const withReferences: RecordValue[] = [];
				for (const entry of converted) {
					if (referenceMetadata.has(entry.id)) withReferences.push(referenceMetadata.get(entry.id)!);
					withReferences.push(entry);
				}
				converted = withReferences;
			}
			const index = new Map(converted.map((entry) => [text(entry.id), entry]));
			for (const [tip, expected] of retained) {
				const mappedTip = tails.get(tip) ?? stateTail(tip);
				if (!mappedTip || !isDeepStrictEqual(contributions(converted, mappedTip, index), expected))
					refuse(`native receipt grouping changes retained context on branch ${tip}`);
			}
		}
		const selected = (record: JournalRecord, path: JsonPath, rewrite?: JournalRewrite): JournalReplacement => ({
			write: (sink) => writeJournalValue(scan.source, record, path, sink, rewrite),
		});
		const systemRewrite = (root: JsonPath, message: RecordValue): JournalRewrite => ({
			omit: (path) =>
				(path.length === root.length + 1 && systemFields.includes(String(path.at(-1)))) ||
				(path.length === root.length + 3 &&
					["toolsAdded", "toolsRemoved"].includes(String(path[root.length])) &&
					[...callFields, ...resultFields, "toolSearch"].includes(String(path.at(-1)))),
			replace: (path) => {
				const key = String(path[root.length]);
				if (!["toolsAdded", "toolsRemoved"].includes(key)) return undefined;
				const item = array(message[key])[Number(path[root.length + 1])];
				if (path.length === root.length + 2 && typeof item === "string") return { value: tool({ name: item }) };
				if (path.length === root.length + 3 && path.at(-1) === "name") return { value: tool(item).name };
				return undefined;
			},
		});
		const messageRewrite = (record: JournalRecord): JournalRewrite => {
			const message = object(record.value.message);
			if (message.role === "system") return systemRewrite(["message"], message);
			return {
				overrides:
					message.role === "toolResult" ? { toolName: { value: tool(message, true).toolName } } : undefined,
				omit: (path) =>
					message.role === "assistant"
						? (path.length === 2 && path[1] === "toolExecutionFailed") ||
							(path.length === 4 &&
								path[0] === "message" &&
								path[1] === "content" &&
								object(array(message.content)[Number(path[2])]).type === "toolCall" &&
								[...callFields, ...resultFields, "toolSearch"].includes(String(path[3])))
						: message.role === "toolResult" &&
							path.length === 2 &&
							[...callFields, ...resultFields, "toolSearch"].includes(String(path[1])),
				replace: (path) =>
					message.role === "assistant" &&
					path.length === 4 &&
					path[0] === "message" &&
					path[1] === "content" &&
					path[3] === "name" &&
					object(array(message.content)[Number(path[2])]).type === "toolCall"
						? { value: tool(array(message.content)[Number(path[2])]).name }
						: undefined,
			};
		};
		const writeCarried = (value: RecordValue, sink: JsonByteSink): void => {
			const source = carriedSources.get(value)!;
			const rewrite = messageRewrite(source.record);
			const overrides: Record<string, JournalReplacement> = { ...rewrite.overrides };
			if (source.content) {
				overrides.content = {
					write: (output) => {
						output("[");
						source.content!.forEach((block, index) => {
							if (index) output(",");
							const location = blockSources.get(block) ?? callLocations.get(block)!;
							const root: JsonPath = ["message", "content", location.index];
							const blankThinking = "blankThinking" in location && location.blankThinking;
							writeJournalValue(scan.source, location.record, root, output, {
								overrides: blankThinking
									? { thinking: { value: "" } }
									: block.type === "toolCall"
										? { name: { value: block.name } }
										: undefined,
								omit: (path) =>
									block.type === "toolCall" &&
									path.length === root.length + 1 &&
									[...callFields, ...resultFields, "toolSearch"].includes(String(path.at(-1))),
							});
						});
						output("]");
					},
				};
				overrides.usage = { value: zeroUsage };
				overrides.stopReason = { value: "toolUse" };
			}
			writeJournalValue(scan.source, source.record, ["message"], sink, {
				...rewrite,
				overrides,
				omit: (path) =>
					rewrite.omit?.(path) === true ||
					(source.content !== undefined && path.length === 2 && path[1] === "errorMessage") ||
					(source.receipt === true && path.length === 2 && path[1] === "usage"),
			});
		};
		const writeMetadata = (value: RecordValue, sink: JsonByteSink): void => {
			const data = object(value.data);
			const source = recordById.get(data.sourceEntryId)!;
			const root: JsonPath = source.value.systemMessage !== undefined ? ["systemMessage"] : ["message"];
			sink("{");
			let first = true;
			for (const [key, item] of Object.entries(data)) {
				if (!first) sink(",");
				first = false;
				sink(`${JSON.stringify(key)}:`);
				if (key === "originalSnapshot") writeJournalValue(scan.source, source, [], sink);
				else if (key === "toolsAdded") writeJournalValue(scan.source, source, ["message", "toolsAdded"], sink);
				else if (key !== "system") sink(JSON.stringify(item));
				else {
					sink("{");
					let firstField = true;
					for (const key of Object.keys(object(item))) {
						if (!firstField) sink(",");
						firstField = false;
						sink(`${JSON.stringify(key)}:`);
						writeJournalValue(scan.source, source, [...root, key], sink);
					}
					sink("}");
				}
			}
			sink("}");
		};
		// Publish a complete, fsynced inode only if no output entry exists, including dangling symlinks.
		const temporary = join(dirname(resolve(outputPath)), `.pi-session-conversion-${randomUUID()}.tmp`);
		const fd = openSync(temporary, "wx", 0o600);
		try {
			try {
				copyJournalRecord(scan.source, scan.records[0]!, fd);
				for (const value of converted) {
					assertSessionConversionNotRequired([value]);
					const source = recordById.get(value.id);
					const carried = carriedSources.has(value);
					const declaration = declarationSources.get(value);
					const metadata = !source && value.customType === "legacy-conversion-metadata";
					const snapshot = redundant.has(text(value.id));
					if (!source || carried || snapshot) {
						const payload = carried || declaration ? "message" : metadata || snapshot ? "data" : undefined;
						if (!payload) writeFileSync(fd, `${JSON.stringify(value)}\n`);
						else {
							writeFileSync(
								fd,
								`${JSON.stringify(Object.fromEntries(Object.entries(value).filter(([key]) => key !== payload))).slice(0, -1)},${JSON.stringify(payload)}:`,
							);
							const sink: JsonByteSink = (bytes) => writeFileSync(fd, bytes);
							if (carried) writeCarried(value, sink);
							else if (declaration) {
								const message = object(value.message);
								sink(
									`${JSON.stringify({ role: "system", content: "", timestamp: message.timestamp }).slice(0, -1)},"toolsAdded":`,
								);
								writeJournalValue(
									scan.source,
									declaration,
									["message", "toolsAdded"],
									sink,
									systemRewrite(["message"], object(declaration.value.message)),
								);
								sink("}");
							} else if (snapshot) {
								sink('{"original":');
								writeJournalValue(scan.source, source!, [], sink);
								sink("}");
							} else writeMetadata(value, sink);
							writeFileSync(fd, "}\n");
						}
						continue;
					}
					const overrides: Record<string, JournalReplacement> = {};
					for (const key of [
						"type",
						"parentId",
						"customType",
						"firstKeptEntryId",
						"tokensBefore",
						"fromHook",
						"fromId",
					])
						if (Object.hasOwn(value, key) && value[key] !== source.value[key])
							overrides[key] = { value: value[key] };
					if (source.value.type === "context_window") {
						const handoff = source.value.handoff === undefined ? undefined : field(source, ["handoff"]);
						overrides.summary = {
							value: `${value.summary}${handoff ? `\n\nHandoff from the previous window:\n${handoff}` : ""}`,
						};
						overrides.details = { value: value.details };
					}
					if (value.message !== undefined) {
						const final = recordById.get(finalByFirst.get(text(value.id)) ?? value.id)!;
						overrides.message = selected(final, ["message"], messageRewrite(final));
					}
					if (value.systemMessage !== undefined)
						overrides.systemMessage = selected(
							source,
							["systemMessage"],
							systemRewrite(["systemMessage"], object(source.value.systemMessage)),
						);
					transformJournalRecord(scan.source, source, fd, {
						overrides,
						omit: (path) =>
							path.length === 1 &&
							(entryFields.includes(String(path[0])) ||
								(source.value.type === "context_window" &&
									["handoff", "retainedToolResultIds"].includes(String(path[0])))),
					});
				}
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			try {
				verifyJournalSource(scan.source);
			} catch {
				refuse("source changed during conversion; stop its writer first");
			}
			publishLocalFileExclusiveSync(temporary, outputPath);
		} finally {
			rmSync(temporary, { force: true });
		}
	} finally {
		closeJournalSource(scan.source);
	}
}
