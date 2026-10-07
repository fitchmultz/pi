import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { getAgentDir } from "../config.ts";
import { resolvePath } from "../utils/paths.ts";
import type { SessionStartEvent, ToolDefinition } from "./extensions/index.ts";
import { applyProviderRegistrations } from "./extensions/provider-registrations.ts";
import { ModelRuntime } from "./model-runtime.ts";
import {
	DefaultResourceLoader,
	type DefaultResourceLoaderOptions,
	type ResourceLoader,
	type ResourceLoaderReloadOptions,
} from "./resource-loader.ts";
import { type CreateAgentSessionOptions, type CreateAgentSessionResult, createAgentSession } from "./sdk.ts";
import type { SessionManager } from "./session-manager.ts";
import { SettingsManager } from "./settings-manager.ts";
import { resolveWorkingSession } from "./working-session.ts";

/**
 * Non-fatal issues collected while creating services or sessions.
 *
 * Runtime creation returns diagnostics to the caller instead of printing or
 * exiting. The app layer decides whether warnings should be shown and whether
 * errors should abort startup.
 */
export interface AgentSessionRuntimeDiagnostic {
	type: "info" | "warning" | "error";
	message: string;
}

/**
 * Inputs for creating cwd-bound runtime services.
 *
 * These services are recreated whenever the effective session cwd changes.
 * CLI-provided resource paths should be resolved to absolute paths before they
 * reach this function, so later cwd switches do not reinterpret them.
 */
export interface CreateAgentSessionServicesOptions {
	cwd: string;
	workingSession?: CreateAgentSessionOptions["workingSession"];
	agentDir?: string;
	settingsManager?: SettingsManager;
	modelRuntime?: ModelRuntime;
	modelRuntimeSignal?: AbortSignal;
	extensionFlagValues?: Map<string, boolean | string>;
	resourceLoaderOptions?: Omit<DefaultResourceLoaderOptions, "cwd" | "agentDir" | "settingsManager">;
	resourceLoaderReloadOptions?: ResourceLoaderReloadOptions;
}

/**
 * Inputs for creating an AgentSession from already-created services.
 *
 * Use this after services exist and any cwd-bound model/tool/session options
 * have been resolved against those services.
 */
export interface CreateAgentSessionFromServicesOptions {
	services: AgentSessionServices;
	sessionManager: SessionManager;
	sessionStartEvent?: SessionStartEvent;
	workingSession?: CreateAgentSessionOptions["workingSession"];
	model?: Model<any>;
	thinkingLevel?: ThinkingLevel;
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	tools?: string[];
	excludeTools?: CreateAgentSessionOptions["excludeTools"];
	noTools?: CreateAgentSessionOptions["noTools"];
	customTools?: ToolDefinition[];
}

/**
 * Coherent cwd-bound runtime services for one effective session cwd.
 *
 * This is infrastructure only. The AgentSession itself is created separately so
 * session options can be resolved against these services first.
 */
export interface AgentSessionServices {
	cwd: string;
	agentDir: string;
	modelRuntime: ModelRuntime;
	settingsManager: SettingsManager;
	resourceLoader: ResourceLoader;
	diagnostics: AgentSessionRuntimeDiagnostic[];
	workingSessionResourcesPrepared?: CreateAgentSessionOptions["workingSessionResourcesPrepared"];
}

function applyExtensionFlagValues(
	resourceLoader: ResourceLoader,
	extensionFlagValues: Map<string, boolean | string> | undefined,
): AgentSessionRuntimeDiagnostic[] {
	if (!extensionFlagValues) {
		return [];
	}

	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	const extensionsResult = resourceLoader.getExtensions();
	const registeredFlags = new Map<string, { type: "boolean" | "string" }>();
	for (const extension of extensionsResult.extensions) {
		for (const [name, flag] of extension.flags) {
			registeredFlags.set(name, { type: flag.type });
		}
	}

	const unknownFlags: string[] = [];
	for (const [name, value] of extensionFlagValues) {
		const flag = registeredFlags.get(name);
		if (!flag) {
			unknownFlags.push(name);
			continue;
		}
		if (flag.type === "boolean") {
			extensionsResult.runtime.flagValues.set(name, true);
			continue;
		}
		if (typeof value === "string") {
			extensionsResult.runtime.flagValues.set(name, value);
			continue;
		}
		diagnostics.push({
			type: "error",
			message: `Extension flag "--${name}" requires a value`,
		});
	}

	if (unknownFlags.length > 0) {
		diagnostics.push({
			type: "error",
			message: `Unknown option${unknownFlags.length === 1 ? "" : "s"}: ${unknownFlags.map((name) => `--${name}`).join(", ")}`,
		});
	}

	return diagnostics;
}

/**
 * Create cwd-bound runtime services.
 *
 * Returns services plus diagnostics. It does not create an AgentSession.
 */
export async function createAgentSessionServices(
	options: CreateAgentSessionServicesOptions,
): Promise<AgentSessionServices> {
	const saved = resolveWorkingSession(options.workingSession);
	if (saved && !saved.launch)
		throw new Error("Launch-less native restore requires an explicit SDK ResourceLoader and agentDir");
	const cwd = resolvePath(saved?.cwd ?? options.cwd);
	const agentDir = resolvePath(saved?.launch?.agentDir ?? options.agentDir ?? getAgentDir());
	if (saved?.launch?.offline !== undefined) {
		if (saved.launch.offline) process.env.PI_OFFLINE = "1";
		else delete process.env.PI_OFFLINE;
	}
	const modelRuntime =
		options.modelRuntime ??
		(await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
			signal: options.modelRuntimeSignal,
		}));
	if (saved?.launch?.offline !== undefined) modelRuntime.setOffline(saved.launch.offline);
	const settingsManager =
		options.settingsManager ?? SettingsManager.create(cwd, agentDir, { projectTrusted: saved?.launch?.trustProject });
	if (saved?.launch?.trustProject !== undefined) settingsManager.setProjectTrusted(saved.launch.trustProject);
	if (saved) settingsManager.restoreWorkingSession(saved.settings, saved.settingsLayers);
	const reloadOptions = saved ? { workingSession: saved } : options.resourceLoaderReloadOptions;
	const resourceLoader = new DefaultResourceLoader({
		...(options.resourceLoaderOptions ?? {}),
		cwd,
		agentDir,
		settingsManager,
	});
	await resourceLoader.reload(reloadOptions);

	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	const extensionsResult = resourceLoader.getExtensions();
	const errors = await applyProviderRegistrations(extensionsResult.runtime, modelRuntime);
	extensionsResult.errors.push(...errors.map((error) => ({ path: error.extensionPath, error: error.error })));
	diagnostics.push(
		...errors.map((error) => ({
			type: "error" as const,
			message: `Extension "${error.extensionPath}" error: ${error.error}`,
		})),
	);
	diagnostics.push(...applyExtensionFlagValues(resourceLoader, options.extensionFlagValues));

	const prepared = reloadOptions?.workingSession ?? reloadOptions?.workingSessionPolicy;
	return {
		cwd,
		agentDir,
		modelRuntime,
		settingsManager,
		resourceLoader,
		diagnostics,
		workingSessionResourcesPrepared: prepared
			? {
					cwd: prepared.cwd,
					launch: prepared.launch,
					settings: prepared.settings,
					settingsLayers: prepared.settingsLayers,
					flags: prepared.flags,
				}
			: undefined,
	};
}

/**
 * Create an AgentSession from previously created services.
 *
 * This keeps session creation separate from service creation so callers can
 * resolve model, thinking, tools, and other session inputs against the target
 * cwd before constructing the session.
 */
export async function createAgentSessionFromServices(
	options: CreateAgentSessionFromServicesOptions,
): Promise<CreateAgentSessionResult> {
	return createAgentSession({
		cwd: options.services.cwd,
		agentDir: options.services.agentDir,
		modelRuntime: options.services.modelRuntime,
		settingsManager: options.services.settingsManager,
		resourceLoader: options.services.resourceLoader,
		sessionManager: options.sessionManager,
		model: options.model,
		thinkingLevel: options.thinkingLevel,
		scopedModels: options.scopedModels,
		tools: options.tools,
		excludeTools: options.excludeTools,
		noTools: options.noTools,
		customTools: options.customTools,
		sessionStartEvent: options.sessionStartEvent,
		workingSession: options.workingSession,
		workingSessionResourcesPrepared: options.services.workingSessionResourcesPrepared,
	});
}
