import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { Api, CacheTraceContext, Model } from "@earendil-works/pi-ai";
import { cacheTraceDigest } from "@earendil-works/pi-ai/utils/cache-trace";
import { PACKAGE_NAME, VERSION } from "../config.ts";
import type { ExtensionRunner, LoadExtensionsResult } from "./extensions/index.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import type { ResourceLoader } from "./resource-loader.ts";
import type { SessionManager } from "./session-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";

/** Temporary passive provenance. No credential resolution or disk reads when disabled. */
export function createCacheTraceContext(
	loader: ResourceLoader,
	models: ModelRuntime,
	manager: SessionManager,
	settings: SettingsManager,
	getRunner: () => ExtensionRunner | undefined,
): (
	selected: Model<Api> | undefined,
	routingId: string | undefined,
	supplied?: CacheTraceContext,
) => CacheTraceContext | undefined {
	let runtimeGeneration: string | undefined;
	let loaded: LoadExtensionsResult | undefined;
	let runner: ExtensionRunner | undefined;
	let reloadGeneration = -1;
	let directory: string | undefined;
	let manifest: Pick<CacheTraceContext, "extensions" | "extensionsDigest" | "catalogDigest"> = {};
	return (selected, routingId, supplied) => {
		if (!process.env.PI_CACHE_TRACE_DIR) return undefined;
		try {
			// Recorder admission is also the privacy/lifetime gate for provenance collection.
			if (!cacheTraceDigest("sdk-provenance")) return undefined;
			runtimeGeneration ??= randomUUID();
			const current = loader.getExtensions();
			if (loaded !== current || runner !== getRunner() || directory !== process.env.PI_CACHE_TRACE_DIR) {
				loaded = current;
				runner = getRunner();
				directory = process.env.PI_CACHE_TRACE_DIR;
				reloadGeneration++;
				const extensions = [
					...current.extensions.map((extension) => {
						let digest: string | undefined;
						try {
							const stat = statSync(extension.resolvedPath);
							if (stat.isFile() && stat.size <= 2 * 1024 * 1024) {
								digest = cacheTraceDigest(readFileSync(extension.resolvedPath));
							}
						} catch {
							// Inline/builtin factories and unavailable entries have no disk receipt.
						}
						return { path: extension.path, loaded: true, digest };
					}),
					...current.errors.map(({ path }) => ({ path, loaded: false })),
				];
				manifest = {
					extensions,
					extensionsDigest: cacheTraceDigest(extensions),
					catalogDigest: cacheTraceDigest(
						models
							.getModelsOfType("chat")
							.map(({ provider, id, api, compat }) => ({ provider, id, api, compat })),
					),
				};
			}
			const branch = manager.getBranch();
			const reset = branch.findLast((entry) => entry.type === "compaction" || entry.type === "branch_summary");
			const sessionId = manager.getSessionId();
			return {
				...supplied,
				...manifest,
				purpose:
					supplied?.purpose ??
					(routingId === sessionId ? (process.env.PI_SUBAGENT_CHILD === "1" ? "child" : "parent") : "unknown"),
				sessionId,
				branchId: manager.getLeafId() ?? "root",
				windowId: reset?.id ?? "initial",
				runtimeGeneration,
				reloadGeneration,
				selectedProvider: selected?.provider,
				selectedModel: selected?.id,
				release: `${PACKAGE_NAME}@${VERSION}`,
				configGeneration: cacheTraceDigest({
					blockImages: settings.getBlockImages(),
					transport: settings.getTransport(),
					cacheRetention: process.env.PI_CACHE_RETENTION === "long" ? "long" : "short",
				}),
				coverageGaps: [
					...(supplied?.coverageGaps ?? []),
					"loaded_module_graph_unverified",
					"extension_entry_disk_snapshot",
					"external_config_generation_unknown",
					...(supplied?.authGeneration === undefined ? ["auth_generation_unknown"] : []),
				],
			};
		} catch {
			return { ...supplied, purpose: supplied?.purpose ?? "unknown", coverageGaps: ["sdk_provenance_unavailable"] };
		}
	};
}
