import { describe, expect, it } from "vitest";
import { ShellDecoder, type ShellSource } from "../../src/harness/utils/shell-decoder.ts";

const sources: ShellSource[] = ["stdout", "stderr"];

describe("ShellDecoder", () => {
	it.each(["¢", "€", "😀"])("keeps every split of %s independent of the other pipe", (character) => {
		const bytes = new TextEncoder().encode(character);
		for (const source of sources) {
			const other = source === "stdout" ? "stderr" : "stdout";
			for (let split = 1; split < bytes.length; split++) {
				const decoder = new ShellDecoder();
				expect(decoder.push(bytes.subarray(0, split), source)).toBe("");
				expect(decoder.push(new TextEncoder().encode("WARN\n"), other)).toBe("WARN\n");
				expect(decoder.push(bytes.subarray(split), source)).toBe(character);
				expect(decoder.finish()).toBe("");
			}
		}
	});

	it.each(sources)("finishes %s once without closing the other pipe", (source) => {
		const other = source === "stdout" ? "stderr" : "stdout";
		const decoder = new ShellDecoder();
		expect(decoder.push(Uint8Array.of(0xe2), source)).toBe("");
		expect(decoder.end(source)).toBe("�");
		expect(decoder.end(source)).toBe("");
		expect(decoder.push(Uint8Array.of(0x82, 0xac), source)).toBe("");
		expect(decoder.push(Uint8Array.of(0xc2), other)).toBe("");
		expect(decoder.finish()).toBe("�");
		expect(decoder.finish()).toBe("");
		expect(decoder.push(Uint8Array.of(0xa2), other)).toBe("");
	});

	it("applies the selected BOM policy independently to each pipe", () => {
		for (const ignoreBOM of [false, true]) {
			const decoder = new ShellDecoder({ ignoreBOM });
			for (const source of sources) {
				expect(decoder.push(Uint8Array.of(0xef), source)).toBe("");
				expect(decoder.push(Uint8Array.of(0xbb, 0xbf, 0x78), source)).toBe(ignoreBOM ? "\ufeffx" : "x");
			}
		}
	});

	it("closes both sources even when fatal decoding fails at finish", () => {
		const decoder = new ShellDecoder({ fatal: true });
		decoder.push(Uint8Array.of(0xe2), "stdout");
		expect(() => decoder.finish()).toThrow();
		for (const source of sources) expect(decoder.push(Uint8Array.of(0x78), source)).toBe("");
		expect(decoder.finish()).toBe("");
	});
});
