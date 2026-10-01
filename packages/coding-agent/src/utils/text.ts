/** Decode without replacing invalid bytes or discarding a byte order mark. */
export function decodeUtf8(content: Uint8Array): string {
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content);
	} catch {
		throw new Error("Cannot edit file: input is not valid UTF-8.");
	}
}

/** Split a leading UTF-8 byte order mark from decoded text. */
export function splitBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

/** Remove a leading UTF-8 byte order mark from decoded text. */
export function stripBom(content: string): string {
	return splitBom(content).text;
}
