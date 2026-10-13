import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as docker from "../src/docker.ts";

vi.mock("../src/docker.ts");

const expectedObservations = ["without_docs", "with_docs", "with_docs", "without_docs"].map((variant, index) => ({
	evalSet: "Example workflow",
	caseId: "handles the case",
	variant,
	model: "fixture/model",
	runNumber: index < 2 ? 1 : 2,
	outcome: "errored",
}));
const originalArgv = process.argv;
const originalExitCode = process.exitCode;
let artifactDirectory: string;

beforeEach(() => {
	vi.resetModules();
	vi.resetAllMocks();
	process.argv = [
		process.execPath,
		"cli.ts",
		"evals/example.docs.eval.ts",
		"--provider",
		"fixture",
		"--model",
		"model",
		"--runs-per-variant",
		"2",
	];
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.mocked(docker.requireEvalAuthFile).mockReturnValue("unused-auth.json");
	vi.mocked(docker.buildImages).mockReturnValue({
		without_docs: { name: "without-docs", id: "control" },
		with_docs: { name: "with-docs", id: "treatment" },
	});
	vi.mocked(docker.createDockerContext).mockImplementation(
		(images, directory, authPath, provider, model, runsPerVariant) => {
			artifactDirectory = directory;
			return { images, artifactDirectory: directory, authPath, provider, model, runsPerVariant };
		},
	);
	vi.mocked(docker.discoverCases).mockImplementation((context, variant) => {
		const path = join(context.artifactDirectory, `${variant}-discovery.json`);
		writeFileSync(
			path,
			JSON.stringify([
				{
					name: "Example workflow > handles the case",
					file: "/repo/packages/evals/evals/example.docs.eval.ts",
				},
			]),
		);
		return path;
	});
});

afterEach(async () => {
	process.argv = originalArgv;
	process.exitCode = originalExitCode;
	vi.restoreAllMocks();
	if (artifactDirectory) await rm(artifactDirectory, { recursive: true, force: true });
});

describe("documentation comparison persistence", () => {
	it("persists each completed failed arm before starting the next", async () => {
		let completed = 0;
		vi.mocked(docker.runTask).mockImplementation((context) => {
			const journalPath = join(context.artifactDirectory, "observations.jsonl");
			if (completed === 0) {
				expect(existsSync(journalPath)).toBe(false);
			} else {
				expect(readFileSync(journalPath, "utf8")).toBe(
					expectedObservations
						.slice(0, completed)
						.map((record) => `${JSON.stringify(record)}\n`)
						.join(""),
				);
			}
			completed += 1;
			return undefined;
		});

		await vi.importActual("../src/cli.ts");

		expect(completed).toBe(4);
		expect(process.exitCode).toBe(1);
		const persisted = await readFile(join(artifactDirectory, "observations.jsonl"), "utf8");
		expect(persisted).toBe(expectedObservations.map((record) => `${JSON.stringify(record)}\n`).join(""));
		const report = JSON.parse(await readFile(join(artifactDirectory, "report.json"), "utf8"));
		expect(report.blockedPairs).toHaveLength(2);
		expect(report.operationalTotals.map(({ runs }: { runs: number }) => runs)).toEqual([2, 2]);
	});

	it("leaves earlier completed arms readable when a later arm is interrupted", async () => {
		const interruption = new Error("task interrupted");
		vi.mocked(docker.runTask).mockImplementation(() => {
			if (vi.mocked(docker.runTask).mock.calls.length === 3) throw interruption;
			return undefined;
		});

		await expect(vi.importActual("../src/cli.ts")).rejects.toBe(interruption);

		const persisted = await readFile(join(artifactDirectory, "observations.jsonl"), "utf8");
		expect(persisted).toBe(
			expectedObservations
				.slice(0, 2)
				.map((record) => `${JSON.stringify(record)}\n`)
				.join(""),
		);
		expect(existsSync(join(artifactDirectory, "report.json"))).toBe(false);
	});
});
