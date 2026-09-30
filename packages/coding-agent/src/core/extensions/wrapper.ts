/**
 * Tool wrappers for extension-registered tools.
 *
 * These wrappers only adapt tool execution so extension tools receive the runner context.
 * Tool call and tool result interception is handled by AgentSession via agent-core hooks.
 */

import { isDeepStrictEqual } from "node:util";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { SourceInfo } from "../source-info.ts";
import { wrapToolDefinition } from "../tools/tool-definition-wrapper.ts";
import type { ExtensionRunner } from "./runner.ts";
import type { RegisteredTool, ToolDefinition } from "./types.ts";

interface ExecutionBinding {
	sourceInfo: SourceInfo;
	execute: ToolDefinition["execute"];
	adapted: AgentTool["execute"];
}

const executionBindings = new WeakMap<ExtensionRunner, WeakMap<ToolDefinition, ExecutionBinding>>();

/**
 * Wrap a RegisteredTool into an AgentTool.
 * Uses the runner's createToolContext() for consistent context across tools and event handlers.
 */
export function wrapRegisteredTool(registeredTool: RegisteredTool, runner: ExtensionRunner): AgentTool {
	const { definition, sourceInfo } = registeredTool;
	let bindings = executionBindings.get(runner);
	if (!bindings) {
		bindings = new WeakMap();
		executionBindings.set(runner, bindings);
	}
	const createContext = (toolCallId: string, signal: AbortSignal | undefined) =>
		runner.createToolContext(toolCallId, signal);
	const tool = wrapToolDefinition(definition, createContext);
	let binding = bindings.get(definition);
	if (!binding || !isDeepStrictEqual(binding.sourceInfo, sourceInfo)) {
		binding = { sourceInfo: { ...sourceInfo }, execute: definition.execute, adapted: tool.execute };
		bindings.set(definition, binding);
	}
	const execution = binding;
	return {
		...tool,
		get name() {
			return definition.name;
		},
		get parameters() {
			return definition.parameters;
		},
		get outputSchema() {
			return definition.outputSchema;
		},
		get constrainedSampling() {
			return definition.constrainedSampling;
		},
		get prepareArguments() {
			return definition.prepareArguments;
		},
		get executionMode() {
			return definition.executionMode;
		},
		get execute() {
			// Keep refreshes stable, but expose live executor/owner replacement to admission.
			if (execution.execute !== definition.execute || !isDeepStrictEqual(execution.sourceInfo, sourceInfo)) {
				execution.sourceInfo = { ...sourceInfo };
				execution.execute = definition.execute;
				execution.adapted = wrapToolDefinition(definition, createContext).execute;
			}
			return execution.adapted;
		},
	};
}

/**
 * Wrap all registered tools into AgentTools.
 * Uses the runner's createToolContext() for consistent context across tools and event handlers.
 */
export function wrapRegisteredTools(registeredTools: RegisteredTool[], runner: ExtensionRunner): AgentTool[] {
	return registeredTools.map((tool) => wrapRegisteredTool(tool, runner));
}
