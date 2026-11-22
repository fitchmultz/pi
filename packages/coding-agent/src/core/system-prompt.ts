/**
 * System prompt construction and project context loading
 */

import { release } from "node:os";
import { win32 as win32Path } from "node:path";
import { getSystemMessageText } from "@earendil-works/pi-ai";
import { getStablePackageDir } from "../config.ts";
import { getShellConfig } from "../utils/shell.ts";
import { formatSkillsForPrompt, type Skill } from "./skills.ts";

export interface HostEnvironmentInfo {
	/** Operating system platform (for example `process.platform`: `"darwin"`, `"linux"`). */
	platform: string;
	/** Operating system kernel/version release (for example `os.release()`). */
	release: string;
	/** CPU architecture (for example `process.arch`: `"arm64"`, `"x64"`). */
	arch: string;
	/** Shell executable basename (for example `"bash"`, `"zsh"`), omitted when unavailable. */
	shell?: string;
	/** Node.js runtime version (for example `process.version`: `"v24.22.3"`). */
	nodeVersion: string;
}

export interface ResolveHostEnvironmentOptions {
	/** Configured shell path (for example `settings.shellPath`). */
	shellPath?: string;
}

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces the default prefix). */
	customPrompt?: string;
	/** Exact full prompt replacement set by a before_agent_start handler. */
	forceSystemPrompt?: string;
	/** Tools to include in prompt. Default: [read, bash, edit, write]. */
	selectedTools?: string[];
	/**
	 * Selected tools whose declarations requests leave out (`prepareLoadout` hidden declarations).
	 * They are reachable only through another tool, so the tool list and rules leave them out too.
	 */
	hiddenTools?: string[];
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Guideline bullets contributed by each tool, keyed by tool name. */
	toolGuidelines?: Record<string, string[]>;
	/** Additional guideline bullets appended to the default system prompt rules. */
	promptGuidelines?: string[];
	/** Text appended from user configuration before project context, skills, and cwd. */
	appendSystemPrompt?: string;
	/** Additional XML-wrapped prompt sections keyed by tag name. */
	sections?: Record<string, string>;
	/** Working directory. */
	cwd: string;
	/** Static host environment metadata for the `<host>` section. Defaults to current process info. */
	host?: HostEnvironmentInfo;
	/** Active model ID used for model-family prompt guidance (for example `"gpt-6.2-sol"`). */
	modelId?: string;
	/** Pre-loaded context files. */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. */
	skills?: Skill[];
}

export type NormalizedBuildSystemPromptOptions = BuildSystemPromptOptions & {
	selectedTools: string[];
	hiddenTools: string[];
	toolSnippets: Record<string, string>;
	toolGuidelines: Record<string, string[]>;
	promptGuidelines: string[];
	appendSystemPrompt: string;
	sections: Record<string, string>;
	contextFiles: Array<{ path: string; content: string }>;
	skills: Skill[];
};

/**
 * Ordered system prompt sections, keyed by name. `preamble` is untagged text; every other
 * section is wrapped in a tag of the same name so the model can match later updates to it.
 * These become `SystemMessage.sections` in the transcript.
 */
export type SystemPromptSections = Record<string, string>;

const SYSTEM_PROMPT_SECTION_NAME = /^[a-z][a-z0-9_-]*$/;
const GPT_6_2_MODEL_PATTERN = /(?:^|\/)gpt-6\.2(?:[-.]|$)/i;

/** Whether `modelId` identifies a GPT-6.2 model (including provider-prefixed IDs). */
export function isGpt62Model(modelId?: string): boolean {
	return modelId !== undefined && GPT_6_2_MODEL_PATTERN.test(modelId.trim());
}

/**
 * Cache-stable behavioral guidance for GPT-6.2 models, adapted from OpenAI's GPT-6.2 prompting
 * and Codex guidance to counter cryptic shorthand, contrived gates, false product assumptions,
 * and premature stopping without interfering with other model families.
 */
export const GPT_6_2_MODEL_GUIDANCE = [
	"Write clearly and directly in plain English, like a capable colleague:",
	"- Treat every reply as the user's first look: keep it self-contained and drop working shorthand, internal labels, invented compound jargon, cryptic tag chains, and process narration.",
	'- State outcomes and facts directly. Avoid contrastive filler ("X, not Y"), preemptive disclaimers, unsolicited warnings, or repeating points the user can already see.',
	"- Include exact identifiers, paths, or commands only when they help the user understand or act.",
	"",
	"Stay grounded in the user's actual request and codebase:",
	"- Do not invent requirements, policies, edge-case checklists, or approval/verification gates that the user, repository, or genuine technical dependencies do not require.",
	"- Do not assume or override product design decisions on the user's behalf. Ask once plainly when a choice materially changes user-facing behavior or product direction and is not already settled; resolve routine, reversible implementation choices yourself and state any material assumption.",
	"- Reuse existing code, types, and abstractions in the repository. Keep changes simple, readable, and strictly scoped: no unrequested files, config churn, formatting sweeps, extra options, unnecessary indirection, or low-value tests.",
	"",
	"Follow through to completion:",
	"- Bias toward action within authorized scope. When asked to build, fix, or finish work, execute and verify the requested outcome instead of stopping at a plan, partial result, or routine confirmation.",
	"- When corrected or told something is missing, fix the issue directly rather than just acknowledging or explaining it.",
].join("\n");

const HOST_PLATFORM_LABELS: Record<string, string> = {
	darwin: "macOS",
	linux: "Linux",
	android: "Android",
	win32: "Windows",
};

/** Resolve static, per-process host environment facts for the `<host>` system prompt section. */
export function resolveHostEnvironmentInfo(options?: ResolveHostEnvironmentOptions): HostEnvironmentInfo {
	const rawShell = options?.shellPath?.trim() || getShellConfig().shell.trim();
	const shell = rawShell ? win32Path.basename(rawShell) : undefined;
	return {
		platform: process.platform,
		release: release(),
		arch: process.arch,
		...(shell ? { shell } : {}),
		nodeVersion: process.version,
	};
}

function formatHostOsLine(host: HostEnvironmentInfo): string {
	const label = Object.hasOwn(HOST_PLATFORM_LABELS, host.platform) ? HOST_PLATFORM_LABELS[host.platform] : undefined;
	if (label) {
		const details = host.release
			? `${host.platform} ${host.release}, ${host.arch}`
			: `${host.platform}, ${host.arch}`;
		return `OS: ${label} (${details})`;
	}
	const details = host.release ? `${host.release}, ${host.arch}` : host.arch;
	return `OS: ${host.platform} (${details})`;
}

function formatHostSection(host: HostEnvironmentInfo): string {
	const lines = [formatHostOsLine(host)];
	if (host.shell) lines.push(`Shell: ${host.shell}`);
	lines.push(`Node: ${host.nodeVersion}`);
	return lines.join("\n");
}

/** Normalize prompt input into the mutable, collection-complete shape exposed to extensions. */
export function normalizeBuildSystemPromptOptions(input: BuildSystemPromptOptions): NormalizedBuildSystemPromptOptions {
	return {
		customPrompt: input.customPrompt,
		forceSystemPrompt: input.forceSystemPrompt,
		selectedTools: [...(input.selectedTools ?? ["read", "bash", "edit", "write"])],
		hiddenTools: [...(input.hiddenTools ?? [])],
		toolSnippets: { ...(input.toolSnippets ?? {}) },
		toolGuidelines: Object.fromEntries(
			Object.entries(input.toolGuidelines ?? {}).map(([name, guidelines]) => [name, [...guidelines]]),
		),
		promptGuidelines: [...(input.promptGuidelines ?? [])],
		appendSystemPrompt: input.appendSystemPrompt ?? "",
		sections: { ...(input.sections ?? {}) },
		cwd: input.cwd,
		host: input.host ? { ...input.host } : undefined,
		...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
		contextFiles: (input.contextFiles ?? []).map((file) => ({ ...file })),
		skills: (input.skills ?? []).map((skill) => ({ ...skill })),
	};
}

function renderProjectContext(contextFiles: Array<{ path: string; content: string }>): string {
	return [
		"Project-specific instructions and guidelines:",
		...contextFiles.map(
			({ path, content }) => `<project_instructions path="${path}">\n${content}\n</project_instructions>`,
		),
	].join("\n\n");
}

function buildRules(
	selectedTools: string[],
	toolGuidelines: Record<string, string[]>,
	promptGuidelines: string[],
	omitConciseRule = false,
): string {
	const rules: string[] = [];
	const seen = new Set<string>();
	const addRule = (rule: string): void => {
		const normalized = rule.trim();
		if (!normalized || seen.has(normalized)) return;
		seen.add(normalized);
		rules.push(normalized);
	};

	const hasBash = selectedTools.includes("bash");
	const hasPowerShell = selectedTools.includes("powershell");
	const hasGrep = selectedTools.includes("grep");
	const hasFind = selectedTools.includes("find");
	const hasLs = selectedTools.includes("ls");

	if ((hasBash || hasPowerShell) && !hasGrep && !hasFind && !hasLs) {
		if (hasBash && hasPowerShell) {
			addRule("Use bash or PowerShell for file operations like listing, searching, and finding files");
		} else if (hasPowerShell) {
			addRule("Use PowerShell for file operations like listing, searching, and finding files");
		} else {
			addRule("Use bash for file operations like ls, rg, find");
		}
	}

	for (const name of selectedTools) {
		for (const rule of toolGuidelines[name] ?? []) addRule(rule);
	}
	for (const rule of promptGuidelines) addRule(rule);
	if (!omitConciseRule) addRule("Be concise in your responses");
	addRule("Show file paths clearly when working with files");
	return rules.map((rule) => `- ${rule}`).join("\n");
}

/** Build the ordered, independently replaceable sections of the structured system prompt. */
export function buildSystemPromptSections(input: BuildSystemPromptOptions): SystemPromptSections {
	const options = normalizeBuildSystemPromptOptions(input);
	const {
		customPrompt,
		selectedTools,
		hiddenTools,
		toolSnippets,
		toolGuidelines,
		promptGuidelines,
		appendSystemPrompt,
		sections: customSections,
		cwd,
		host,
		modelId,
		contextFiles,
		skills,
	} = options;

	for (const name of Object.keys(customSections)) {
		if (!SYSTEM_PROMPT_SECTION_NAME.test(name) || name === "preamble") {
			throw new Error(`Invalid system prompt section name: ${name}`);
		}
	}

	const declaredTools = selectedTools.filter((name) => !hiddenTools.includes(name));
	const gpt62 = isGpt62Model(modelId);
	const promptSections: Record<string, string> = {};
	if (customPrompt) {
		promptSections.preamble = customPrompt;
	} else {
		promptSections.preamble =
			"You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.";
		const visibleTools = declaredTools.filter((name) => !!toolSnippets[name]);
		const tools =
			visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets[name]}`).join("\n") : "(none)";
		promptSections.tools = `${tools}\n\nAdditional tools may be available.`;
		promptSections.rules = buildRules(declaredTools, toolGuidelines, promptGuidelines, gpt62);
		if (gpt62) promptSections.model_guidance = GPT_6_2_MODEL_GUIDANCE;
		// The package folder differs per installed release. It is named once, and only here, so a
		// session that continues under another release gets one changed section and no changed tool.
		promptSections.docs = `Pi documentation (read only when the user asks about the harness itself, its SDK, extensions, themes, skills, or TUI):
- Pi package folder: ${getStablePackageDir()}
- Resolve README.md (main documentation), docs/... and examples/... (extensions, custom tools, SDK) under the Pi package folder, not the current working directory
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), packages (docs/packages.md), environment variables (docs/environment-variables.md), MCP servers (docs/mcp.md), codemode scripts and non-LLM models such as classifiers and image models (docs/codemode.md)
- Before implementing harness changes, read the documentation sections and examples that cover the APIs and behavior you will change, including the references those sections depend on. Read full documents only when the change spans their scope.`;
	}

	if (appendSystemPrompt) promptSections.addendum = appendSystemPrompt;
	if (contextFiles.length > 0) promptSections.project_context = renderProjectContext(contextFiles);
	// A hidden reader is still reachable through another tool, so skills stay but the hint names no tool.
	const readers = ["read", "bash"] as const;
	const skillFileReadTool =
		readers.find((tool) => declaredTools.includes(tool)) ??
		(readers.some((tool) => selectedTools.includes(tool)) ? "indirect" : undefined);
	if (skillFileReadTool && skills.length > 0) {
		const skillsPrompt = formatSkillsForPrompt(skills, skillFileReadTool).trim();
		if (skillsPrompt) promptSections.skills = skillsPrompt;
	}
	promptSections.cwd = cwd.replace(/\\/g, "/");
	promptSections.host = formatHostSection(host ?? resolveHostEnvironmentInfo());
	for (const [name, content] of Object.entries(customSections)) {
		if (content) promptSections[name] = content;
	}

	const sections: SystemPromptSections = { preamble: promptSections.preamble };
	for (const [name, content] of Object.entries(promptSections)) {
		if (name !== "preamble") sections[name] = `<${name}>\n${content}\n</${name}>`;
	}
	return sections;
}

/**
 * The complete prompt state for `input`. A forced prompt is opaque and lives in `content`
 * with no sections; otherwise `content` is empty and the structured sections carry the prompt.
 */
export function buildSystemPromptState(input: BuildSystemPromptOptions): {
	content: string;
	sections?: SystemPromptSections;
} {
	if (input.forceSystemPrompt !== undefined) return { content: input.forceSystemPrompt };
	return { content: "", sections: buildSystemPromptSections(input) };
}

/** Build the system prompt text, rendered exactly as the transcript's system message replays it. */
export function buildSystemPrompt(input: BuildSystemPromptOptions): string {
	return getSystemMessageText({ role: "system", ...buildSystemPromptState(input), timestamp: 0 });
}

/**
 * Diff the sections the model currently has (replayed from the transcript, so never null)
 * against the desired ones. Returns a `SystemMessage.sections` patch, or undefined when
 * nothing changed.
 */
export function diffSystemPromptSections(
	previous: Record<string, string | null>,
	current: SystemPromptSections,
): Record<string, string | null> | undefined {
	const patch: Record<string, string | null> = {};
	for (const [name, text] of Object.entries(current)) {
		if (previous[name] !== text) patch[name] = text;
	}
	for (const name of Object.keys(previous)) {
		if (current[name] === undefined) patch[name] = null;
	}
	return Object.keys(patch).length > 0 ? patch : undefined;
}
