/** Unfinished work that will message its session when it ends. */
export interface BackgroundWork {
	/** The background run ID, or the reporting extension's own ID (a `background_command` job ID). */
	id: string;
	/** What is running, in one line. */
	description: string;
	/** Request cancellation. Resolves when requested; the work may still be stopping. */
	cancel(): Promise<void>;
}

/** Asks each extension for the unfinished work it owns for this session. Handlers must not change state. */
export interface BackgroundWorkEvent {
	type: "background_work";
}

export interface BackgroundWorkEventResult {
	work: BackgroundWork[];
}
