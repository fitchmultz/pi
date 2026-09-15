import { addUsage, type SessionStats, type UsageRow } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { sql } from "../sql.ts";
import type { SqliteDatabase } from "../types.ts";
import { readSessionRow } from "./session-row.ts";

export function readSessionStats(db: SqliteDatabase, sessionId: string): SessionStats {
	const row = readSessionRow(db, sessionId);
	return {
		messageCount: row.message_count,
		usage: JSON.parse(row.usage_payload) as Usage,
	};
}

export function incrementMessageCount(db: SqliteDatabase, sessionId: string): void {
	sql`UPDATE sessions SET message_count = message_count + 1 WHERE id = ${sessionId}`.run(db);
}

export function addUsageToSessionStats(db: SqliteDatabase, sessionId: string, usage: UsageRow["usage"]): void {
	const current = readSessionStats(db, sessionId).usage;
	sql`UPDATE sessions SET usage_payload = ${JSON.stringify(addUsage(current, usage))} WHERE id = ${sessionId}`.run(db);
}
