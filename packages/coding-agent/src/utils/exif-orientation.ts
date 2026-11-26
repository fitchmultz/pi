import { getExifOrientation } from "@earendil-works/pi-tui/exif-orientation";
import type { PhotonImageType } from "./photon.ts";

type Photon = typeof import("@silvia-odwyer/photon-node");

type DstIndexFn = (x: number, y: number, w: number, h: number) => number;

function rotate90(photon: Photon, image: PhotonImageType, dstIndex: DstIndexFn): PhotonImageType {
	const w = image.get_width();
	const h = image.get_height();
	const src = image.get_raw_pixels();
	const dst = new Uint8Array(src.length);

	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const srcIdx = (y * w + x) * 4;
			const dstIdx = dstIndex(x, y, w, h) * 4;
			dst[dstIdx] = src[srcIdx];
			dst[dstIdx + 1] = src[srcIdx + 1];
			dst[dstIdx + 2] = src[srcIdx + 2];
			dst[dstIdx + 3] = src[srcIdx + 3];
		}
	}

	return new photon.PhotonImage(dst, h, w);
}

// Flip orientations mutate in-place. Rotations return a new image (caller must free the old one if different).
export function applyExifOrientation(
	photon: Photon,
	image: PhotonImageType,
	originalBytes: Uint8Array,
): PhotonImageType {
	const orientation = getExifOrientation(originalBytes);
	if (orientation === 1) return image;

	switch (orientation) {
		case 2:
			photon.fliph(image);
			return image;
		case 3:
			photon.fliph(image);
			photon.flipv(image);
			return image;
		case 4:
			photon.flipv(image);
			return image;
		case 5: {
			const rotated = rotate90(photon, image, (x, y, _w, h) => x * h + (h - 1 - y));
			photon.fliph(rotated);
			return rotated;
		}
		case 6:
			return rotate90(photon, image, (x, y, _w, h) => x * h + (h - 1 - y));
		case 7: {
			const rotated = rotate90(photon, image, (x, y, w, h) => (w - 1 - x) * h + y);
			photon.fliph(rotated);
			return rotated;
		}
		case 8:
			return rotate90(photon, image, (x, y, w, h) => (w - 1 - x) * h + y);
		default:
			return image;
	}
}
