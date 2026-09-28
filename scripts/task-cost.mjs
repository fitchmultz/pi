#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const classes = ["input", "cacheWrite", "cacheRead", "output"];
const zero = () => Object.fromEntries(classes.map((key) => [key, 0]));

function amount(value, label) {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`Invalid ${label}`);
	return value;
}

/** Read every branch: abandoned attempts still cost money. Never open a journal for writing. */
export async function readLedger(file) {
	const records = [];
	const counts = { checkpoints: 0, malformedLines: 0, retryMarkers: 0, contextWindows: 0 };
	let header;
	let lineNumber = 0;
	for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
		lineNumber++;
		if (!line.trim()) continue;
		let entry;
		try { entry = JSON.parse(line); } catch { counts.malformedLines++; continue; }
		if (entry.type === "session") { header = entry; continue; }
		if (!header?.id) throw new Error(`Missing session header: ${file}:${lineNumber}`);
		if (entry.checkpoint) { counts.checkpoints++; continue; }
		if (entry.customType === "pi:retried-message") counts.retryMarkers++;
		if (entry.type === "context_window") counts.contextWindows++;
		const message = entry.message;
		let usage, provider, model, source;
		if (entry.type === "usage") {
			({ usage, provider, model } = entry);
			source = entry.kind === "subagent" ? "subagent" : entry.kind === "cache_warm" ? "cache_warm" : "other_usage";
		} else if (entry.type === "message" && message?.role === "assistant") {
			({ usage, provider } = message);
			model = message.responseModel ?? message.model;
			source = "assistant";
		} else if (entry.type === "message" && message?.role === "toolResult" && message.usage) {
			usage = message.usage;
			source = "tool";
		} else if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
			usage = entry.usage;
			source = "summary";
		} else continue;
		if (typeof entry.id !== "string" || !entry.id) throw new Error(`Missing usage entry ID: ${file}:${lineNumber}`);
		if (!usage) throw new Error(`Missing usage: ${file}:${lineNumber}`);
		const tokens = Object.fromEntries(classes.map((key) => [key, amount(usage[key], `${key} tokens at ${file}:${lineNumber}`)]));
		const cost = usage.cost ? Object.fromEntries([...classes, "total"].map((key) => [key, amount(usage.cost[key], `${key} cost at ${file}:${lineNumber}`)])) : null;
		// Forks retain entry IDs/timestamps; native rollups reference sessionId:entryId.
		const fingerprint = createHash("sha256").update(JSON.stringify([entry.type, entry.id, entry.timestamp, provider, model, usage])).digest("hex");
		const aliases = [`${header.id}:${entry.id}`, `copy:${fingerprint}`];
		if (entry.contributionId?.startsWith("subagent:")) aliases.push(entry.contributionId.slice("subagent:".length));
		if (message?.responseId) aliases.push(`response:${provider}:${message.responseId}`);
		const details = message?.diagnostics?.find((diagnostic) => diagnostic.type === "provider_request")?.details;
		const contribution = entry.contributionId?.startsWith("subagent:") ? entry.contributionId.slice("subagent:".length) : undefined;
		records.push({ aliases, tokens, cost, provider: provider ?? "unknown", model: model ?? "unknown", source,
			importedSessionId: contribution?.slice(0, contribution.lastIndexOf(":")),
			assistant: source === "assistant", error: message?.stopReason === "error", aborted: message?.stopReason === "aborted",
			attempts: details ? (details.sseAttempts ?? 0) + (details.websocketAttempts ?? 0) : null,
			latencyMs: details?.finishedMs ?? null, returnedServiceTier: details?.returnedServiceTier ?? "unknown" });
	}
	if (!header?.id) throw new Error(`Missing session header: ${file}`);
	return { sessionId: header.id, records, counts };
}

export function summarizeRecords(records) {
	const aliases = new Map();
	const unique = new Set();
	let duplicates = 0;
	for (const record of records) {
		const matches = [...new Set(record.aliases.map((key) => aliases.get(key)).filter(Boolean))];
		const target = matches[0] ?? { ...record, aliases: [...record.aliases] };
		for (const match of matches) {
			if (JSON.stringify(match.tokens) !== JSON.stringify(record.tokens) || JSON.stringify(match.cost) !== JSON.stringify(record.cost)) {
				throw new Error(`Conflicting usage for ${record.aliases[0]}`);
			}
			if (match !== target) { unique.delete(match); target.aliases.push(...match.aliases); duplicates++; }
		}
		if (matches.length) {
			duplicates++;
			target.aliases.push(...record.aliases);
			// The original response provides transport facts absent from a parent's rollup.
			const source = target.source === "subagent" || record.source === "subagent" ? "subagent" : target.source;
			if (record.assistant && !target.assistant) Object.assign(target, record, { aliases: target.aliases });
			target.source = source;
		}
		for (const key of target.aliases) aliases.set(key, target);
		unique.add(target);
	}
	const result = { tokens: zero(), recordedCostUsd: { ...zero(), total: 0 }, missingCostRecords: 0, records: unique.size, duplicates,
		directResponses: 0, directErrors: 0, directAborts: 0, transportAttempts: 0, responsesWithTransportCounts: 0,
		bySource: {}, byModel: {}, returnedServiceTiers: {}, latencyMs: [] };
	for (const record of unique) {
		for (const group of [result, result.bySource[record.source] ??= { tokens: zero(), recordedCostUsd: { ...zero(), total: 0 }, records: 0 },
			result.byModel[`${record.provider}/${record.model}`] ??= { tokens: zero(), recordedCostUsd: { ...zero(), total: 0 }, records: 0 }]) {
			for (const key of classes) { group.tokens[key] += record.tokens[key]; group.recordedCostUsd[key] += record.cost?.[key] ?? 0; }
			group.recordedCostUsd.total += record.cost?.total ?? 0;
			if (group !== result) group.records++;
		}
		if (!record.cost) result.missingCostRecords++;
		if (record.assistant && record.source === "assistant") {
			result.directResponses++;
			result.directErrors += Number(record.error);
			result.directAborts += Number(record.aborted);
			result.returnedServiceTiers[record.returnedServiceTier] = (result.returnedServiceTiers[record.returnedServiceTier] ?? 0) + 1;
			if (record.attempts !== null) { result.transportAttempts += record.attempts; result.responsesWithTransportCounts++; }
			if (record.latencyMs !== null) result.latencyMs.push(record.latencyMs);
		}
	}
	const promptTokens = result.tokens.input + result.tokens.cacheWrite + result.tokens.cacheRead;
	result.cacheReadFraction = promptTokens ? result.tokens.cacheRead / promptTokens : null;
	return result;
}

/** Outcomes come from an explicit task manifest, never inferred from an assistant saying "done". */
export async function analyzeTasks(manifest, baseDir = process.cwd()) {
	if (!Array.isArray(manifest.tasks) || !manifest.tasks.length) throw new Error("Manifest needs nonempty tasks");
	const tasks = [];
	const usedFiles = new Set();
	const ids = new Set();
	const usageOwners = new Map();
	for (const task of manifest.tasks) {
		if (!task.id || ids.has(task.id)) throw new Error("Task IDs must be nonempty and unique");
		ids.add(task.id);
		if (!["completed", "failed", "unknown"].includes(task.outcome)) throw new Error(`Invalid outcome: ${task.id}`);
		if (task.outcome === "completed" && !task.evidence) throw new Error(`Completed task needs evidence: ${task.id}`);
		if (!Array.isArray(task.sessions) || !task.sessions.length) throw new Error(`Task needs session paths: ${task.id}`);
		const ledgers = [];
		if (task.supplementalSessions !== undefined && !Array.isArray(task.supplementalSessions)) throw new Error(`Invalid supplementalSessions: ${task.id}`);
		for (const session of [...task.sessions, ...(task.supplementalSessions ?? [])]) {
			const file = path.resolve(baseDir, session);
			if (usedFiles.has(file)) throw new Error(`Session assigned more than once: ${file}`);
			usedFiles.add(file);
			ledgers.push(await readLedger(file));
		}
		// Descendant supplements need every alias-bearing intermediate journal. A grandchild alone
		// cannot be matched to a root rollup that names the intervening worker's usage entry.
		const reachable = new Set(ledgers.slice(0, task.sessions.length).map((ledger) => ledger.sessionId));
		for (let previous = -1; previous !== reachable.size;) {
			previous = reachable.size;
			for (const ledger of ledgers) if (reachable.has(ledger.sessionId)) {
				for (const record of ledger.records) if (record.importedSessionId) reachable.add(record.importedSessionId);
			}
		}
		for (const ledger of ledgers.slice(task.sessions.length)) {
			if (!reachable.has(ledger.sessionId)) throw new Error(`Unlinked supplemental session ${ledger.sessionId}: supply all intermediate worker journals and finalized parent contributions`);
		}
		const records = ledgers.flatMap((ledger) => ledger.records);
		for (const record of records) {
			for (const alias of record.aliases) {
				const owner = usageOwners.get(alias);
				if (owner && owner !== task.id) throw new Error(`Usage shared by tasks ${owner} and ${task.id}; group their continuation sessions into one task`);
				usageOwners.set(alias, task.id);
			}
		}
		const summary = summarizeRecords(records);
		if (task.actualBilledUsd !== undefined && !task.billingEvidence) throw new Error(`Actual billing needs evidence: ${task.id}`);
		const additionalCharges = (task.additionalCharges ?? []).map((charge) => {
			if (!charge.kind || !charge.evidence) throw new Error(`Additional charge needs kind and evidence: ${task.id}`);
			return { ...charge, usd: amount(charge.usd, "additional charge") };
		});
		tasks.push({ id: task.id, outcome: task.outcome, evidence: task.evidence ?? null, ...summary,
			journal: Object.fromEntries(Object.keys(ledgers[0].counts).map((key) => [key, ledgers.reduce((sum, ledger) => sum + ledger.counts[key], 0)])),
			additionalCharges, billingEvidence: task.billingEvidence ?? null,
			actualBilledUsd: task.actualBilledUsd === undefined ? null : amount(task.actualBilledUsd, "actual billed USD") });
	}
	const completed = tasks.filter((task) => task.outcome === "completed").length;
	const unknown = tasks.filter((task) => task.outcome === "unknown").length;
	const estimatedTotal = tasks.reduce((sum, task) => sum + task.recordedCostUsd.total + task.additionalCharges.reduce((total, charge) => total + charge.usd, 0), 0);
	const completeBilling = tasks.every((task) => task.actualBilledUsd !== null);
	return { basis: "Recorded catalog-priced USD estimates, not invoices. Codex subscription/credit costs are not API-dollar charges. Additional charges are separate; actualBilledUsd must include all charges.",
		limitations: ["sessions must contain roots/continuations only. Use supplementalSessions for descendants, including every intermediate worker journal; missing/unfinished rollups require reconciliation.",
			"Counts for imported usage are contribution records, not proven worker model-call counts. Direct response/transport statistics exclude imported-only workers; supplied child journals without rollups count as directly observed assistants.",
			"Unreported failed-call usage, external review/service bills, task quality and price freshness require independent evidence.",
			"Assign each complete task and all its follow-up/retry sessions once. Cost includes failed/unknown tasks; the denominator requires evidenced completion."],
		tasks, completed, unknown, estimatedTotalUsd: estimatedTotal,
		estimatedUsdPerCompletedTask: completed ? estimatedTotal / completed : null,
		actualUsdPerCompletedTask: completed && completeBilling && !unknown ? tasks.reduce((sum, task) => sum + task.actualBilledUsd, 0) / completed : null,
		measurementComplete: !unknown && completeBilling && tasks.every((task) => !task.missingCostRecords && !task.journal.malformedLines) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (process.argv.length !== 3 || process.argv[2] === "--help") {
		console.log("Usage: node scripts/task-cost.mjs <task-manifest.json>\nSee packages/coding-agent/docs/task-cost.md. Reads local journals; makes no model calls.");
		process.exitCode = process.argv[2] === "--help" ? 0 : 1;
	} else {
		try {
			const file = path.resolve(process.argv[2]);
			console.log(JSON.stringify(await analyzeTasks(JSON.parse(await readFile(file, "utf8")), path.dirname(file)), null, 2));
		} catch (error) { console.error(error.message); process.exitCode = 1; }
	}
}
