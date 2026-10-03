import type { ModelRuntime } from "../model-runtime.ts";
import type { ExtensionError, ExtensionRuntime } from "./types.ts";

/** Apply factory registrations before model selection, retaining native per-extension diagnostics. */
export async function applyProviderRegistrations(
	runtime: ExtensionRuntime,
	modelRuntime: ModelRuntime,
	onModelsChanged?: () => void,
): Promise<ExtensionError[]> {
	const errors: ExtensionError[] = [];
	let changed = false;
	const register = (extensionPath: string, event: string, action: () => void) => {
		try {
			action();
			changed = true;
			onModelsChanged?.();
		} catch (error) {
			errors.push({
				extensionPath,
				event,
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
		}
	};
	for (const { name, config, extensionPath } of runtime.pendingProviderRegistrations)
		register(extensionPath, "register_provider", () => modelRuntime.registerProvider(name, config));
	runtime.pendingProviderRegistrations = [];
	for (const { provider, extensionPath } of runtime.pendingNativeProviderRegistrations)
		register(extensionPath, "register_provider", () => modelRuntime.registerNativeProvider(provider));
	runtime.pendingNativeProviderRegistrations = [];
	for (const { definition, extensionPath } of runtime.pendingVirtualModelRegistrations)
		register(extensionPath, "register_virtual_model", () => modelRuntime.registerVirtualModel(definition));
	runtime.pendingVirtualModelRegistrations = [];
	changed =
		runtime.bindProviderAuthFallbacks((id, fallback) => modelRuntime.registerProviderAuthFallback(id, fallback)) ||
		changed;
	if (changed) await modelRuntime.refresh({ allowNetwork: false });
	return errors;
}
