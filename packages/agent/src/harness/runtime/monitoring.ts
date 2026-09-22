import type { Context } from "../context.ts";
import { AbortRequested } from "../execution/effect-gate.ts";
import type { LaneState, SessionReader } from "../session/types.ts";
import { laneState } from "../session/values.ts";
import type { Lane } from "./lane.ts";
import type { Drive } from "./types.ts";

/** Check after asynchronous preparation, immediately before an external effect. */
export async function assertMonitoringActive<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
): Promise<void> {
	await lane.refreshMonitoringStop(drive.context);
	if (lane.state.monitoringStop === undefined) return;
	const cancellation = Promise.resolve();
	drive.beginAbort(cancellation);
	drive.signalAbort();
	throw new AbortRequested(cancellation);
}

/** Find a persisted stop belonging to any conversation that shares this history. */
export async function findMonitoringStop(
	reader: SessionReader,
	tipId: string | null,
	context: Context,
): Promise<LaneState["monitoringStop"]> {
	if (tipId === null) return undefined;
	let history: Set<string> | undefined;
	for (const { value } of await reader.scanValues(laneState(""), context)) {
		const stopped = value.monitoringStop;
		if (stopped?.tipId == null) continue;
		history ??= new Set((await reader.scanBranch({ start: tipId }, context)).map((entry) => entry.id));
		const source = await reader.scanBranch({ start: stopped.tipId }, context);
		for (const entry of source) {
			if (history.has(entry.id)) return stopped;
		}
	}
	return undefined;
}
