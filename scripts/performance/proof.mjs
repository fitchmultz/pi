import { createHash } from "node:crypto";

export function sha256(value) {
	return createHash("sha256")
		.update(typeof value === "string" || ArrayBuffer.isView(value) ? value : (JSON.stringify(value) ?? "undefined"))
		.digest("hex");
}

// Called outside measured regions. Compare witnesses, never diagnostic counters or timestamps.
export function witness(name, input, output) {
	console.log(JSON.stringify({ verification: { name, inputSha256: sha256(input), outputSha256: sha256(output) } }));
}
