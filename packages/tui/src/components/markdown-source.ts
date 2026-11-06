import type { Token, Tokens } from "marked";
import { type SelectionDocument, SelectionSource, SourceText } from "../selection-source.ts";

/** Maps Marked's declared token transformations back to one original Markdown block. */
export class MarkdownSource extends SelectionSource {
	private readonly rawSources = new WeakMap<object, SourceText>();
	private readonly contentSources = new WeakMap<object, SourceText>();

	constructor(original: string, source: SourceText, token: Token, document: SelectionDocument, offset: number) {
		super(original, document, offset, token.type === "space" || token.type === "def" ? "trivia" : "content");
		this.indexTokens([token], source);
	}

	raw(token: object): SourceText {
		return this.rawSources.get(token) ?? new SourceText("", []);
	}

	content(token: object): SourceText {
		return this.contentSources.get(token) ?? this.raw(token);
	}

	private indexTokens(tokens: readonly Token[], parent: SourceText): void {
		let cursor = 0;
		for (const token of tokens) {
			const start = parent.text.indexOf(token.raw, cursor);
			if (start < 0) continue;
			const raw = parent.slice(start, start + token.raw.length);
			cursor = start + token.raw.length;
			this.rawSources.set(token, raw);
			let content = raw;
			switch (token.type) {
				case "list": {
					let itemOffset = 0;
					for (const item of token.items) {
						const itemStart = raw.text.indexOf(item.raw, itemOffset);
						if (itemStart < 0) continue;
						const itemRaw = raw.slice(itemStart, itemStart + item.raw.length);
						itemOffset = itemStart + item.raw.length;
						const itemText = itemRaw.lines(item.text);
						this.rawSources.set(item, itemRaw);
						this.contentSources.set(item, itemText);
						this.indexTokens(item.tokens, itemText);
					}
					break;
				}
				case "blockquote":
					content = raw.lines(token.text);
					this.indexTokens(token.tokens ?? [], content);
					break;
				case "heading": {
					const atx = /^ {0,3}#{1,6}(?:[ \t]+|$)/.exec(raw.text);
					content = atx ? raw.slice(atx[0].length).lines(token.text) : raw.lines(token.text);
					this.indexTokens(token.tokens ?? [], content);
					this.format(raw.slice(0, raw.text.trimEnd().length), content);
					break;
				}
				case "strong":
				case "em":
				case "del": {
					const delimiterLength = (token.raw.length - token.text.length) / 2;
					content = raw.slice(delimiterLength, raw.text.length - delimiterLength);
					this.indexTokens(token.tokens ?? [], content);
					this.format(raw, content);
					break;
				}
				case "link":
				case "image": {
					const label = raw.replace(/\\(?=[[\]])/g, "");
					const prefix = token.raw.startsWith("![") ? 2 : /^[<[]/.test(token.raw) ? 1 : 0;
					const labelStart = label.text.indexOf(token.text, prefix);
					content =
						labelStart < 0
							? new SourceText(token.text, [])
							: label.slice(labelStart, labelStart + token.text.length);
					if (token.tokens) this.indexTokens(token.tokens ?? [], content);
					this.format(raw, content);
					break;
				}
				case "codespan": {
					const delimiterLength = /^`+/.exec(raw.text)?.[0].length ?? 0;
					content = raw.slice(delimiterLength, raw.text.length - delimiterLength).replace(/\n/g, " ");
					if (content.text.startsWith(" ") && content.text.endsWith(" ") && /[^ ]/.test(content.text)) {
						content = content.slice(1, content.text.length - 1);
					}
					this.format(raw, content);
					break;
				}
				case "escape":
					content = raw.slice(1);
					this.format(raw, content);
					break;
				case "code":
					content = raw.lines(token.text, token.codeBlockStyle === "indented" ? 0 : 1);
					break;
				case "html":
					content = raw.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
					break;
				case "table":
					this.indexTable(token as Tokens.Table, raw);
					break;
				case "paragraph":
				case "text":
					content = raw.slice(0, token.text.length);
					if (token.tokens) this.indexTokens(token.tokens ?? [], content);
					break;
			}
			this.contentSources.set(token, content);
		}
	}

	private indexTable(token: Tokens.Table, raw: SourceText): void {
		const lines = raw.text.split("\n");
		let offset = 0;
		for (let row = 0; row < lines.length; row++) {
			const cells = row === 0 ? token.header : row >= 2 ? token.rows[row - 2] : undefined;
			if (cells) {
				const line = raw.slice(offset, offset + lines[row].length).replace(/\\(?=\|)/g, "");
				let cursor = /^\s*\|/.exec(line.text)?.[0].length ?? 0;
				for (const cell of cells) {
					const start = line.text.indexOf(cell.text, cursor);
					if (start < 0) continue;
					const content = line.slice(start, start + cell.text.length);
					this.contentSources.set(cell, content);
					this.indexTokens(cell.tokens, content);
					cursor = start + cell.text.length;
					const delimiter = line.text.indexOf("|", cursor);
					if (delimiter >= 0) cursor = delimiter + 1;
				}
			}
			offset += lines[row].length + 1;
		}
	}
}
