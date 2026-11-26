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

/**
 * Load photon and sixel and return a synchronous Sixel encoder for pi-tui.
 * Returns undefined if photon or sixel cannot be loaded.
 */
export async function loadSixelEncoder(): Promise<SixelImageEncoder | undefined> {
	const [photon, sixelMod] = await Promise.all([loadPhoton(), import("sixel").catch(() => undefined)]);
	if (!photon || !sixelMod?.image2sixel) return undefined;
	const { image2sixel } = sixelMod;
	return ({ base64Data, widthPx, heightPx }) => {
		try {
			const bytes = new Uint8Array(Buffer.from(base64Data, "base64"));
			const rawImage = photon.PhotonImage.new_from_byteslice(bytes);
			const oriented = applyExifOrientation(photon, rawImage, bytes);
			if (oriented !== rawImage) rawImage.free();
			const targetW = Math.max(1, Math.round(widthPx));
			const targetH = Math.max(1, Math.round(heightPx));
			let resized: ReturnType<typeof photon.PhotonImage.new_from_byteslice> | undefined;
			try {
				if (oriented.get_width() !== targetW || oriented.get_height() !== targetH) {
					resized = photon.resize(oriented, targetW, targetH, photon.SamplingFilter.Lanczos3);
				}
				const source = resized ?? oriented;
				const rgba = source.get_raw_pixels();
				return image2sixel(rgba, source.get_width(), source.get_height(), 256, 1);
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
