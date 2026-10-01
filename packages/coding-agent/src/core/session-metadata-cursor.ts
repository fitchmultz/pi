import type { ReadonlySessionManager, SessionEntry, SessionEntryMetadata } from "./session-manager.ts";

/** Append deltas in journal or active-branch order. Navigation/reload returns a fresh replay. */
export class SessionMetadataCursor {
	private manager?: ReadonlySessionManager;
	private revision = -1;
	private leafId: string | null | undefined;
	private last?: SessionEntry;

	read(manager: ReadonlySessionManager, branch = false): { entries: SessionEntryMetadata[]; reset: boolean } {
		const revision = manager.getEntriesRevision();
		const leafId = branch ? manager.getLeafId() : undefined;
		if (this.manager === manager && this.revision === revision && this.leafId === leafId)
			return { entries: [], reset: false };
		const last =
			this.manager === manager && this.last && manager.getEntry(this.last.id) === this.last ? this.last : undefined;
		const entries: SessionEntryMetadata[] = [];
		let reset = true;
		for (const entry of manager.iterateEntryMetadata({ reverse: true, ...(branch ? { branchFrom: leafId } : {}) })) {
			if (entry.id === last?.id) {
				reset = false;
				break;
			}
			entries.push(entry);
		}
		this.manager = manager;
		this.revision = revision;
		this.leafId = leafId;
		this.last = entries.length ? manager.getEntry(entries[0]!.id) : reset ? undefined : last;
		return { entries: entries.reverse(), reset };
	}
}

const customEntries = new WeakMap<
	ReadonlySessionManager,
	{ cursor: SessionMetadataCursor; ids: Map<string, string> }
>();

/** Latest custom state without rescanning the branch on each request when it has not changed. */
export function getLatestCustomEntry(manager: ReadonlySessionManager, customType: string): SessionEntry | undefined {
	let state = customEntries.get(manager);
	if (!state) {
		state = { cursor: new SessionMetadataCursor(), ids: new Map() };
		customEntries.set(manager, state);
	}
	const { entries, reset } = state.cursor.read(manager, true);
	if (reset) state.ids.clear();
	for (const entry of entries) if (entry.type === "custom") state.ids.set(entry.customType, entry.id);
	const id = state.ids.get(customType);
	return id ? manager.getEntry(id) : undefined;
}
