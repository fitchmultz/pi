import {
	getCapabilities,
	type ImageTranscoder,
	type SixelImageEncoder,
	setImageTranscoder,
	setSixelEncoder,
} from "@earendil-works/pi-tui";
import { applyExifOrientation } from "./exif-orientation.ts";
import { convertImageBytesToPngInWorker } from "./image-resize.ts";
import { encodePngSync } from "./image-resize-core.ts";
import { loadPhoton } from "./photon.ts";

export async function convertImageBytesToPng(bytes: Uint8Array): Promise<Uint8Array | null> {
	return convertImageBytesToPngInWorker(bytes);
}

/**
 * Convert image to PNG format for terminal display.
 * Kitty graphics protocol requires PNG format (f=100).
 */
export async function convertToPng(
	base64Data: string,
	mimeType: string,
): Promise<{ data: string; mimeType: string } | null> {
	// Already PNG, no conversion needed
	if (mimeType === "image/png") {
		return { data: base64Data, mimeType };
	}

	const bytes = new Uint8Array(Buffer.from(base64Data, "base64"));
	const pngBytes = await convertImageBytesToPng(bytes);
	if (!pngBytes) {
		return null;
	}

	return {
		data: Buffer.from(pngBytes).toString("base64"),
		mimeType: "image/png",
	};
}

/**
 * Load photon and return a synchronous PNG transcoder for pi-tui's Kitty image rendering.
 * Returns undefined if photon cannot be loaded.
 */
export async function loadPngTranscoder(): Promise<ImageTranscoder | undefined> {
	const photon = await loadPhoton();
	if (!photon) return undefined;
	return (base64Data) => {
		const pngBytes = encodePngSync(photon, new Uint8Array(Buffer.from(base64Data, "base64")));
		return pngBytes ? Buffer.from(pngBytes).toString("base64") : null;
	};
}

type SixelModule = typeof import("sixel");

function encodeRgbaToSixel(rgba: Uint8Array, width: number, height: number, sixelMod: SixelModule): string {
	let hasTransparent = false;
	let opaqueCount = 0;
	for (let i = 3; i < rgba.length; i += 4) {
		if (rgba[i] === 0) {
			hasTransparent = true;
		} else {
			opaqueCount++;
		}
	}

	if (!hasTransparent) {
		// Normalize non-zero alpha to 255 so image2sixel's quantizer never creates an alpha=0 palette entry.
		for (let i = 3; i < rgba.length; i += 4) {
			rgba[i] = 255;
		}
		return sixelMod.image2sixel(rgba, width, height, 256, 1);
	}

	if (opaqueCount === 0) {
		return `${sixelMod.introducer(1)}"1;1;${width};${height}${sixelMod.FINALIZER}`;
	}

	// Workaround for sixel@0.16.0 (tracked upstream at https://github.com/jerch/node-sixel/issues/34):
	// image2sixel/sixelEncodeIndexed mis-indexes palette slots when alpha=0 entries are present, while
	// sixelEncode handles alpha=0 correctly when every opaque pixel matches a palette entry.
	const uniqueColors = new Map<number, [number, number, number]>();
	let exceeds256 = false;
	for (let i = 0; i < rgba.length; i += 4) {
		if (rgba[i + 3] === 0) {
			rgba[i] = 0;
			rgba[i + 1] = 0;
			rgba[i + 2] = 0;
			continue;
		}
		rgba[i + 3] = 255;
		if (!exceeds256) {
			const key = (rgba[i]! << 16) | (rgba[i + 1]! << 8) | rgba[i + 2]!;
			if (!uniqueColors.has(key)) {
				if (uniqueColors.size >= 256) {
					exceeds256 = true;
				} else {
					uniqueColors.set(key, [rgba[i]!, rgba[i + 1]!, rgba[i + 2]!]);
				}
			}
		}
	}

	let palette: Array<[number, number, number]>;
	if (!exceeds256) {
		palette = Array.from(uniqueColors.values());
	} else {
		// Quantize opaque pixels onto a 6x7x6 RGB cube (<=252 entries) so every opaque pixel matches the palette.
		const cubeColors = new Map<number, [number, number, number]>();
		for (let i = 0; i < rgba.length; i += 4) {
			if (rgba[i + 3] === 0) continue;
			const r = Math.round(rgba[i]! / 51) * 51;
			const g = Math.round((rgba[i + 1]! * 6) / 255) * 42 + (rgba[i + 1]! > 233 ? 3 : 0);
			const b = Math.round(rgba[i + 2]! / 51) * 51;
			rgba[i] = r;
			rgba[i + 1] = g;
			rgba[i + 2] = b;
			const key = (r << 16) | (g << 8) | b;
			if (!cubeColors.has(key)) {
				cubeColors.set(key, [r, g, b]);
			}
		}
		palette = Array.from(cubeColors.values());
	}

	return `${sixelMod.introducer(1)}${sixelMod.sixelEncode(rgba, width, height, palette)}${sixelMod.FINALIZER}`;
}

/**
 * Load photon and sixel and return a synchronous Sixel encoder for pi-tui.
 * Returns undefined if photon or sixel cannot be loaded.
 */
export async function loadSixelEncoder(): Promise<SixelImageEncoder | undefined> {
	// Workaround for sixel@0.16.0: upng.js executes sloppy-mode `module.exports = UPNG = {};` and
	// references `UPNG` inside `UPNG.quantize`, throwing `ReferenceError: UPNG is not defined` in
	// strict ESM bundles (esbuild and Bun `--compile`). Remove once upstream sixel declares `UPNG`.
	if (!("UPNG" in globalThis)) {
		(globalThis as Record<string, unknown>).UPNG = undefined;
	}
	const [photon, sixelImport] = await Promise.all([loadPhoton(), import("sixel").catch(() => undefined)]);
	// Split strict-ESM bundles wrap CJS dynamic imports behind `default` (`export default require_lib()`).
	const sixelMod =
		sixelImport && "image2sixel" in sixelImport
			? sixelImport
			: (sixelImport as { default?: SixelModule } | undefined)?.default;
	if (!photon || !sixelMod?.image2sixel || !sixelMod?.sixelEncode) return undefined;
	return ({ base64Data, widthPx, heightPx }) => {
		try {
			const bytes = new Uint8Array(Buffer.from(base64Data, "base64"));
			const rawImage = photon.PhotonImage.new_from_byteslice(bytes);
			const oriented = applyExifOrientation(photon, rawImage, bytes);
			if (oriented !== rawImage) rawImage.free();
			const boxW = Math.max(1, Math.round(widthPx));
			const boxH = Math.max(1, Math.round(heightPx));
			const srcW = Math.max(1, oriented.get_width());
			const srcH = Math.max(1, oriented.get_height());
			const scale = Math.min(boxW / srcW, boxH / srcH);
			const targetW = Math.max(1, Math.min(boxW, Math.round(srcW * scale)));
			const targetH = Math.max(1, Math.min(boxH, Math.round(srcH * scale)));
			let resized: ReturnType<typeof photon.PhotonImage.new_from_byteslice> | undefined;
			try {
				if (oriented.get_width() !== targetW || oriented.get_height() !== targetH) {
					resized = photon.resize(oriented, targetW, targetH, photon.SamplingFilter.Lanczos3);
				}
				const source = resized ?? oriented;
				const rgba = source.get_raw_pixels();
				return encodeRgbaToSixel(rgba, source.get_width(), source.get_height(), sixelMod);
			} finally {
				resized?.free();
				oriented.free();
			}
		} catch {
			return null;
		}
	};
}

let pngTranscoderLoad: Promise<boolean> | undefined;
let pngTranscoderRegistered = false;
let sixelEncoderLoad: Promise<boolean> | undefined;
let sixelEncoderRegistered = false;

/**
 * On Kitty-protocol terminals, register photon as pi-tui's image transcoder so non-PNG images render.
 * Loads photon once. `onRegistered` runs after registration so callers can re-render images that
 * showed text fallbacks; it is not called if the transcoder was already registered or cannot load.
 */
export function ensurePngTranscoder(onRegistered: () => void): void {
	if (pngTranscoderRegistered || getCapabilities().images !== "kitty") return;
	pngTranscoderLoad ??= loadPngTranscoder().then((transcoder) => {
		if (!transcoder) return false;
		setImageTranscoder(transcoder);
		pngTranscoderRegistered = true;
		return true;
	});
	void pngTranscoderLoad.then((registered) => {
		if (registered) onRegistered();
	});
}

/**
 * On Sixel-protocol terminals (including tmux 3.4+ and iTerm2 fullscreen), register the
 * photon + sixel encoder with pi-tui once and notify callers to re-render fallbacks.
 */
export function ensureSixelEncoder(onRegistered: () => void): void {
	if (sixelEncoderRegistered || getCapabilities().images !== "sixel") return;
	sixelEncoderLoad ??= loadSixelEncoder().then((encoder) => {
		if (!encoder) return false;
		setSixelEncoder(encoder);
		sixelEncoderRegistered = true;
		return true;
	});
	void sixelEncoderLoad.then((registered) => {
		if (registered) onRegistered();
	});
}

/**
 * Ensure whichever synchronous image encoder pi-tui needs for the active terminal protocol
 * (Kitty PNG transcoder for non-PNG images, or Sixel encoder for any image) is registered.
 */
export function ensureImageEncoders(onRegistered: () => void, mimeType?: string): void {
	const protocol = getCapabilities().images;
	if (protocol === "sixel") {
		ensureSixelEncoder(onRegistered);
	} else if (protocol === "kitty" && mimeType !== "image/png") {
		ensurePngTranscoder(onRegistered);
	}
}
