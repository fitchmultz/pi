import { existsSync, readFileSync, rmSync, statSync } from "fs";
import { afterEach, describe, expect, it } from "vitest";
import { executeBashWithOperations } from "../src/core/bash-executor.ts";
import { OutputAccumulator } from "../src/core/tools/output-accumulator.ts";
import { DEFAULT_MAX_BYTES } from "../src/core/tools/truncate.ts";

const paths: string[] = [];
afterEach(() => {
	for (const path of paths.splice(0)) rmSync(path, { force: true });
});

describe("private shell spill logs", () => {
	it.each(["accumulator", "bash"] as const)("keeps %s output private under a permissive umask", async (kind) => {
		const old = process.umask(0);
		const data = "secret\n".repeat(DEFAULT_MAX_BYTES);
		try {
			let path: string;
			if (kind === "accumulator") {
				const output = new OutputAccumulator();
				output.append(Buffer.from(data));
				output.finish();
				await output.closeTempFile();
				path = output.snapshot().fullOutputPath!;
			} else {
				path = (
					await executeBashWithOperations("offline", process.cwd(), {
						exec: async (_command, _cwd, options) => {
							options.onData(Buffer.from(data));
							return { exitCode: 0 };
						},
					})
				).fullOutputPath!;
				// The existing bash executor does not await stream completion.
				for (let i = 0; i < 100 && (!existsSync(path) || statSync(path).size < Buffer.byteLength(data)); i++) {
					await new Promise((resolve) => setTimeout(resolve, 5));
				}
			}
			paths.push(path);
			expect(statSync(path).mode & 0o777).toBe(0o600);
			expect(readFileSync(path, "utf8")).toBe(data);
		} finally {
			process.umask(old);
		}
	});
});
