import { AbortRequested } from "../execution/effect-gate.ts";
import type { Lane } from "./lane.ts";
import type { Drive } from "./types.ts";

/** Check after asynchronous preparation, immediately before an external effect. */
export function assertMonitoringActive<TContext extends object | undefined>(lane: Lane<TContext>, drive: Drive): void {
	if (lane.state.monitoringStop === undefined) return;
	const cancellation = Promise.resolve();
	drive.beginAbort(cancellation);
	drive.signalAbort();
	throw new AbortRequested(cancellation);
}
