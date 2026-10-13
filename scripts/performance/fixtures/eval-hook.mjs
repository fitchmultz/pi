import { writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dockerUrl = pathToFileURL(join(process.env.PI_PERF_REPO, "packages/evals/src/docker.ts")).href;
registerHooks({
	resolve(specifier, context, nextResolve) {
		const result = nextResolve(specifier, context);
		return result.url === dockerUrl ? { ...result, url: import.meta.url } : result;
	},
});

export function requireEvalAuthFile() {
	return "unused-auth.json";
}
export function buildImages() {
	return { without_docs: { name: "control", id: "control" }, with_docs: { name: "treatment", id: "treatment" } };
}
export function createDockerContext(images, artifactDirectory, authPath, provider, model, runsPerVariant) {
	writeFileSync(process.env.PI_PERFORMANCE_STATE, artifactDirectory);
	return { images, artifactDirectory, authPath, provider, model, runsPerVariant };
}
export function discoverCases(context, variant) {
	const reportPath = join(context.artifactDirectory, `${variant}-discovery.json`);
	writeFileSync(
		reportPath,
		JSON.stringify([
			{ name: "Persistence > completes arm", file: "/repo/packages/evals/evals/persistence.docs.eval.ts" },
		]),
	);
	return reportPath;
}
export function runTask() {
	return undefined;
}
