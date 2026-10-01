import { describe, expect, it } from "vitest";
import { formatDimensionNote, type ResizedImage } from "../src/utils/image-resize.ts";

describe("image dimension note", () => {
	it("maps x and y independently without rounding the scale", () => {
		const image: ResizedImage = {
			data: "",
			mimeType: "image/png",
			originalWidth: 3001,
			originalHeight: 2001,
			width: 2000,
			height: 1333,
			wasResized: true,
		};
		expect(formatDimensionNote(image)).toBe(
			"[Image: original 3001x2001, displayed at 2000x1333. Multiply x coordinates by 3001/2000 and y coordinates by 2001/1333 to map to original image.]",
		);
		expect(formatDimensionNote({ ...image, wasResized: false })).toBeUndefined();
	});
});
