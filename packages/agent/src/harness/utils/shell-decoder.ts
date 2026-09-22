import { TextDecoder } from "node:util";

export type ShellSource = "stdout" | "stderr";
type TextDecoderOptions = ConstructorParameters<typeof TextDecoder>[1];

/** Decode each pipe independently; only completed text can be combined. */
export class ShellDecoder {
	readonly #decoders: Record<ShellSource, TextDecoder>;
	readonly #ended = new Set<ShellSource>();

	constructor(options?: TextDecoderOptions) {
		this.#decoders = {
			stdout: new TextDecoder("utf-8", options),
			stderr: new TextDecoder("utf-8", options),
		};
	}

	push(chunk: Uint8Array, source: ShellSource): string {
		if (this.#ended.has(source)) return "";
		return this.#decoders[source].decode(chunk, { stream: true });
	}

	end(source: ShellSource): string {
		if (this.#ended.has(source)) return "";
		this.#ended.add(source);
		return this.#decoders[source].decode();
	}

	finish(): string {
		let text = "";
		try {
			text = this.end("stdout");
		} finally {
			text += this.end("stderr");
		}
		return text;
	}
}
