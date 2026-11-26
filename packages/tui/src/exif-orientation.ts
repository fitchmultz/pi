function parseTiffOrientation(bytes: Uint8Array, tiffStart: number, end: number): number | undefined {
	if (end - tiffStart < 8) return undefined;
	const littleEndian = bytes[tiffStart] === 0x49 && bytes[tiffStart + 1] === 0x49;
	const bigEndian = bytes[tiffStart] === 0x4d && bytes[tiffStart + 1] === 0x4d;
	if (!littleEndian && !bigEndian) return undefined;
	const readU16 = (pos: number): number =>
		littleEndian ? bytes[pos]! | (bytes[pos + 1]! << 8) : (bytes[pos]! << 8) | bytes[pos + 1]!;
	const readU32 = (pos: number): number =>
		littleEndian
			? (bytes[pos]! | (bytes[pos + 1]! << 8) | (bytes[pos + 2]! << 16) | (bytes[pos + 3]! << 24)) >>> 0
			: ((bytes[pos]! << 24) | (bytes[pos + 1]! << 16) | (bytes[pos + 2]! << 8) | bytes[pos + 3]!) >>> 0;
	if (readU16(tiffStart + 2) !== 42) return undefined;
	const ifdOffset = readU32(tiffStart + 4);
	const ifdStart = tiffStart + ifdOffset;
	if (ifdStart < tiffStart || ifdStart + 2 > end) return undefined;
	const entryCount = readU16(ifdStart);
	for (let i = 0; i < entryCount; i++) {
		const entryStart = ifdStart + 2 + i * 12;
		if (entryStart + 12 > end) break;
		if (readU16(entryStart) === 0x0112) {
			const value = readU16(entryStart + 8);
			return value >= 1 && value <= 8 ? value : undefined;
		}
	}
	return undefined;
}

function hasExifHeader(bytes: Uint8Array, start: number, end: number): boolean {
	return (
		end - start >= 6 &&
		bytes[start] === 0x45 &&
		bytes[start + 1] === 0x78 &&
		bytes[start + 2] === 0x69 &&
		bytes[start + 3] === 0x66 &&
		bytes[start + 4] === 0x00 &&
		bytes[start + 5] === 0x00
	);
}

export function parseExifOrientation(bytes: Uint8Array, start: number, end: number): number | undefined {
	if (!hasExifHeader(bytes, start, end)) return undefined;
	return parseTiffOrientation(bytes, start + 6, end);
}

export function parseWebpExifOrientation(bytes: Uint8Array): number | undefined {
	let offset = 12;
	while (offset + 8 <= bytes.length) {
		const chunkId = String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
		const chunkSize =
			(bytes[offset + 4]! | (bytes[offset + 5]! << 8) | (bytes[offset + 6]! << 16) | (bytes[offset + 7]! << 24)) >>>
			0;
		const dataStart = offset + 8;
		const dataEnd = dataStart + chunkSize;
		if (dataEnd > bytes.length) return undefined;
		if (chunkId === "EXIF") {
			const tiffStart = hasExifHeader(bytes, dataStart, dataEnd) ? dataStart + 6 : dataStart;
			return parseTiffOrientation(bytes, tiffStart, dataEnd);
		}
		// RIFF chunks are padded to an even byte boundary.
		offset = dataEnd + (chunkSize % 2);
	}
	return undefined;
}

/**
 * Read the EXIF Orientation tag (1–8) from raw JPEG or WebP bytes.
 * Returns 1 when no valid orientation tag is present.
 */
export function getExifOrientation(bytes: Uint8Array): number {
	// JPEG: starts with FF D8
	if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
		let offset = 2;
		while (offset < bytes.length - 1) {
			if (bytes[offset] !== 0xff) return 1;
			const marker = bytes[offset + 1]!;
			if (marker === 0xff) {
				offset++;
				continue;
			}
			if (offset + 4 > bytes.length) return 1;
			const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
			if (length < 2) return 1;
			const segmentEnd = Math.min(bytes.length, offset + 2 + length);
			if (marker === 0xe1) {
				const orientation = parseExifOrientation(bytes, offset + 4, segmentEnd);
				if (orientation !== undefined) return orientation;
			}
			offset += 2 + length;
		}
		return 1;
	}

	// WebP: starts with RIFF....WEBP
	if (
		bytes.length >= 12 &&
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x46 &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45 &&
		bytes[10] === 0x42 &&
		bytes[11] === 0x50
	) {
		return parseWebpExifOrientation(bytes) ?? 1;
	}

	return 1;
}
