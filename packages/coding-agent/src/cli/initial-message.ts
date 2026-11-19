import type { ImageContent } from "@earendil-works/pi-ai";
import type { Args } from "./args.ts";

export interface InitialMessageInput {
	parsed: Args;
	fileText?: string;
	fileImages?: ImageContent[];
	stdinContent?: string;
}

export interface InitialMessageResult {
	initialMessage?: string;
	initialImages?: ImageContent[];
}

function joinInitialMessageParts(parts: readonly string[]): string {
	let combined = parts[0];
	for (let i = 1; i < parts.length; i++) {
		const next = parts[i];
		const trailingNewlines = combined.match(/(?:\r?\n)+$/)?.[0].match(/\n/g)?.length ?? 0;
		const leadingNewlines = next.match(/^(?:\r?\n)+/)?.[0].match(/\n/g)?.length ?? 0;
		const separator = "\n".repeat(Math.max(0, 2 - trailingNewlines - leadingNewlines));
		combined += separator + next;
	}
	return combined;
}

/**
 * Combine stdin content, @file text, and the first CLI message into a single
 * initial prompt for non-interactive mode.
 */
export function buildInitialMessage({
	parsed,
	fileText,
	fileImages,
	stdinContent,
}: InitialMessageInput): InitialMessageResult {
	const parts: string[] = [];
	if (stdinContent) {
		parts.push(stdinContent);
	}
	if (fileText) {
		parts.push(fileText);
	}

	if (parsed.messages.length > 0) {
		parts.push(parsed.messages[0]);
		parsed.messages.shift();
	}

	return {
		initialMessage: parts.some((part) => part.trim().length > 0) ? joinInitialMessageParts(parts) : undefined,
		initialImages: fileImages && fileImages.length > 0 ? fileImages : undefined,
	};
}
