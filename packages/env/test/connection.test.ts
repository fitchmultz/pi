import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const probe = fileURLToPath(new URL("./fixtures/connection-probe.mjs", import.meta.url));

describe.each(["hello", "request"])("Connection %s frame decoding", (phase) => {
	it("accepts a valid frame and preserves binary payload bytes", () => {
		const result = spawnSync(process.execPath, [probe, "valid", phase], { encoding: "utf8", timeout: 5000 });
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		expect(JSON.parse(result.stdout)).toEqual(
			phase === "hello"
				? { status: "accepted", protocol: 1 }
				: { status: "accepted", json: { value: 42 }, payload: [0, 255, 123] },
		);
	});

	it.each(["invalid-json", "length-overrun", "null-json", "array-json"])(
		"rejects %s without crashing the client process",
		(scenario) => {
			const result = spawnSync(process.execPath, [probe, scenario, phase], { encoding: "utf8", timeout: 5000 });
			expect(result.error).toBeUndefined();
			expect(result.status).toBe(0);
			expect(result.stderr).toBe("");
			expect(JSON.parse(result.stdout)).toEqual({ status: "rejected", name: "RemoteError", code: "unknown" });
		},
	);
});
