import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
	applyEditsToNormalizedContent,
	generateDiffString,
	generateUnifiedPatch,
} from "/pi-performance-source/packages/durable/src/tools/edit-diff.ts";
import { resizeImage } from "/pi-performance-source/packages/coding-agent/src/utils/image-resize.ts";
import { resizeImageInProcess } from "/pi-performance-source/packages/coding-agent/src/utils/image-resize-core.ts";
import { loadPhoton } from "/pi-performance-source/packages/coding-agent/src/utils/photon.ts";
import { witness } from "../proof.mjs";

//        ... cpu.mjs image <width> <height> <runs> [inprocess|worker] [max-base64-bytes]
// Setup is excluded. Each sample runs the actual source owner; checksums are comparable before/after.
const [mode = "edit", sizeArg, countArg, runsArg = "5", variant] = process.argv.slice(2);
const runs = Number(runsArg);
if (!Number.isInteger(runs) || runs < 1) throw new Error("runs must be positive");
const checksum = (text) => createHash("sha256").update(text).digest("hex");
let operation;
let workload;
if (mode === "edit") {
	const mib = Number(sizeArg ?? 8);
	const count = Number(countArg ?? 32);
	if (!(mib > 0) || !Number.isInteger(count) || count < 1) throw new Error("invalid edit workload");
	const lineCount = Math.ceil((mib * 1024 * 1024) / 96);
	const lines = Array.from(
		{ length: lineCount },
		(_, i) => `row-${String(i).padStart(9, "0")} const label = “sample” + 'value';${" ".repeat(30)}\n`,
	);
	const content = lines.join("");
	const edits = Array.from({ length: count }, (_, i) => {
		const line = lines[Math.floor(((i + 1) * lineCount) / (count + 1))];
		const oldText = variant === "fuzzy" ? line.replaceAll("“", '"').replaceAll("”", '"').trimEnd() : line;
		return { oldText, newText: line.replace("sample", `updated-${i}`) };
	});
	workload = {
		mode,
		inputBytes: Buffer.byteLength(content),
		editCount: count,
		inputSha256: checksum(content),
		variant: variant ?? "exact",
	};
	operation = () => {
		const result = applyEditsToNormalizedContent(content, edits, "fixture.ts");
		if (variant === "diff") {
			const display = generateDiffString(result.baseContent, result.newContent);
			const patch = generateUnifiedPatch("fixture.ts", result.baseContent, result.newContent);
			return JSON.stringify({
				checksum: checksum(result.newContent),
				display: checksum(display.diff),
				patch: checksum(patch),
				firstChangedLine: display.firstChangedLine,
			});
		}
		return checksum(result.newContent);
	};
} else if (mode === "image") {
	const width = Number(sizeArg ?? 1600);
	const height = Number(countArg ?? 1000);
	if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2)
		throw new Error("invalid image workload");
	const photon = await loadPhoton();
	if (!photon) throw new Error("Photon unavailable");
	const pixels = new Uint8Array(width * height * 4);
	// A reproducible screenshot-like palette; no random fixture differences between revisions.
	for (let i = 0; i < pixels.length; i += 4) {
		const x = (i / 4) % width;
		const y = Math.floor(i / 4 / width);
		pixels[i] = (x * 7 + y * 3) % 256;
		pixels[i + 1] = Math.floor(x / 12) % 2 ? 220 : 20;
		pixels[i + 2] = Math.floor(y / 10) % 2 ? 90 : 180;
		pixels[i + 3] = 255;
	}
	const fixture = new photon.PhotonImage(pixels, width, height);
	let input;
	try {
		input = new Uint8Array(fixture.get_bytes());
	} finally {
		fixture.free();
	}
	const options = {
		maxWidth: Math.floor(width / 2),
		maxHeight: Math.floor(height / 2),
		maxBytes: Number(process.argv[7] ?? 4.5 * 1024 * 1024),
		jpegQuality: 80,
	};
	const resize = variant === "worker" ? resizeImage : resizeImageInProcess;
	workload = {
		mode,
		width,
		height,
		inputBytes: input.length,
		inputSha256: checksum(input),
		variant: variant ?? "inprocess",
		options,
	};
	operation = async () => {
		const result = await resize(input, "image/png", options);
		if (!result) throw new Error("image returned null");
		return {
			checksum: checksum(result.data),
			bytes: result.data.length,
			mimeType: result.mimeType,
			dimensions: [result.width, result.height],
		};
	};
} else throw new Error("expected edit or image");
console.log(JSON.stringify({ workload, node: process.version }));
for (let run = 0; run < runs; run++) {
	global.gc?.();
	const before = process.memoryUsage();
	const start = performance.now();
	const result = await operation();
	const elapsedMs = performance.now() - start;
	const after = process.memoryUsage();
	witness(mode, workload, result);
	console.log(
		JSON.stringify({
			run,
			elapsedMs,
			heapDelta: after.heapUsed - before.heapUsed,
			rss: after.rss,
			maxRssKiB: process.resourceUsage().maxRSS,
			result,
		}),
	);
}
