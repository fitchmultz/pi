import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, release, tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { type ForkReleaseReceipt, getStablePackageDir } from "../src/config.ts";
import type { Skill } from "../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import { buildSystemPrompt, buildSystemPromptSections, resolveHostEnvironmentInfo } from "../src/core/system-prompt.ts";

const testSkill: Skill = {
	name: "test-skill",
	description: "A test skill.",
	filePath: "/skills/test-skill/SKILL.md",
	baseDir: "/skills/test-skill",
	sourceInfo: createSyntheticSourceInfo("/skills/test-skill/SKILL.md", { source: "test" }),
	disableModelInvocation: false,
};

describe("buildSystemPrompt", () => {
	describe("empty tools", () => {
		test("shows (none) for empty tools list", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("<tools>\n(none)\n");
		});

		test("shows file paths guideline even with no tools", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Show file paths clearly");
		});
	});

	describe("prompt structure", () => {
		test("keeps the default and custom prompt prefixes exact", () => {
			const defaultPrompt = buildSystemPrompt({ cwd: "/tmp", selectedTools: [], contextFiles: [], skills: [] });
			const customPrompt = buildSystemPrompt({
				customPrompt: "You are Exact.",
				cwd: "/tmp",
				selectedTools: [],
				contextFiles: [],
				skills: [],
			});

			expect(defaultPrompt.startsWith("You are a coding assistant running inside pi, a coding agent harness.")).toBe(
				true,
			);
			expect(customPrompt.startsWith("You are Exact.\n\n<cwd>")).toBe(true);
		});

		test("preserves an exact forced prompt without sections", () => {
			expect(buildSystemPrompt({ forceSystemPrompt: "exact", cwd: "/tmp" })).toBe("exact");
		});

		test("maps appended instructions and project context to stable sections", () => {
			const prompt = buildSystemPrompt({
				customPrompt: "You are Exact.",
				appendSystemPrompt: "Additional instructions.",
				contextFiles: [{ path: "/tmp/AGENTS.md", content: "Project instructions." }],
				selectedTools: [],
				skills: [],
				cwd: "/tmp",
			});

			expect(prompt).toContain("<addendum>\nAdditional instructions.\n</addendum>");
			expect(prompt).toContain(
				'<project_context>\nProject-specific instructions and guidelines:\n\n<project_instructions path="/tmp/AGENTS.md">',
			);
			expect(prompt).toContain("<cwd>\n/tmp\n</cwd>");
		});
	});

	describe("host section", () => {
		test("emits <host> directly after <cwd> without modifying <cwd>", () => {
			const host = {
				platform: "darwin",
				release: "24.4.0",
				arch: "arm64",
				shell: "zsh",
				nodeVersion: "v24.22.3",
			};
			const prompt = buildSystemPrompt({
				cwd: "/workspace/project",
				host,
				selectedTools: [],
				contextFiles: [],
				skills: [],
			});
			const sections = buildSystemPromptSections({
				cwd: "/workspace/project",
				host,
				selectedTools: [],
				contextFiles: [],
				skills: [],
			});

			expect(sections.cwd).toBe("<cwd>\n/workspace/project\n</cwd>");
			expect(sections.host).toBe("<host>\nOS: macOS (darwin 24.4.0, arm64)\nShell: zsh\nNode: v24.22.3\n</host>");
			const keys = Object.keys(sections);
			expect(keys.indexOf("host")).toBe(keys.indexOf("cwd") + 1);
			expect(prompt).toContain(
				"<cwd>\n/workspace/project\n</cwd>\n\n<host>\nOS: macOS (darwin 24.4.0, arm64)\nShell: zsh\nNode: v24.22.3\n</host>",
			);
		});

		test("supports platform formatting, shell basename extraction, and omitted shell", () => {
			const linuxWithPathShell = buildSystemPromptSections({
				cwd: "/workspace",
				host: {
					platform: "linux",
					release: "6.8.0",
					arch: "x64",
					shell: "/Users/private-user/bin/bash",
					nodeVersion: "v24.1.0",
				},
			});
			expect(linuxWithPathShell.host).toBe(
				"<host>\nOS: Linux (linux 6.8.0, x64)\nShell: bash\nNode: v24.1.0\n</host>",
			);
			expect(linuxWithPathShell.host).not.toContain("private-user");

			const withoutShell = buildSystemPromptSections({
				cwd: "/workspace",
				host: {
					platform: "freebsd",
					release: "14.1-RELEASE",
					arch: "x64",
					nodeVersion: "v24.1.0",
				},
			});
			expect(withoutShell.host).toBe("<host>\nOS: freebsd (14.1-RELEASE, x64)\nNode: v24.1.0\n</host>");
			expect(withoutShell.host).not.toContain("Shell:");
		});

		test("defaults to static current-process host metadata without leaking hostname, username, or env", () => {
			const sentinelEnvKey = "PI_HOST_SECTION_TEST_SECRET";
			const sentinelEnvValue = "super-secret-env-value-98765";
			process.env[sentinelEnvKey] = sentinelEnvValue;
			try {
				const info = resolveHostEnvironmentInfo();
				expect(info.platform).toBe(process.platform);
				expect(info.release).toBe(release());
				expect(info.arch).toBe(process.arch);
				expect(info.nodeVersion).toBe(process.version);
				if (info.shell !== undefined) {
					expect(info.shell).not.toContain("/");
					expect(info.shell).not.toContain("\\");
				}

				const first = buildSystemPrompt({ cwd: "/workspace", selectedTools: [], contextFiles: [], skills: [] });
				const second = buildSystemPrompt({ cwd: "/workspace", selectedTools: [], contextFiles: [], skills: [] });
				expect(second).toBe(first);

				const sections = buildSystemPromptSections({
					cwd: "/workspace",
					selectedTools: [],
					contextFiles: [],
					skills: [],
				});
				const hostSection = sections.host;
				expect(hostSection).toBeDefined();
				expect(hostSection).toContain(process.platform);
				expect(hostSection).toContain(process.arch);
				expect(hostSection).toContain(process.version);
				expect(hostSection).not.toContain(sentinelEnvKey);
				expect(hostSection).not.toContain(sentinelEnvValue);

				const hostLines = hostSection!.split("\n").slice(1, -1);
				expect(hostLines.every((line) => /^(OS|Shell|Node): /.test(line))).toBe(true);

				const currentHostname = hostname();
				if (currentHostname.length > 3 && !hostSection!.includes(process.platform + currentHostname)) {
					expect(hostSection).not.toContain(currentHostname);
				}
				const currentUser = userInfo().username;
				if (currentUser.length > 3 && currentUser !== "node" && currentUser !== "bash") {
					expect(hostSection).not.toContain(currentUser);
				}
			} finally {
				delete process.env[sentinelEnvKey];
			}
		});
	});

	describe("default tools", () => {
		test("includes all default tools when snippets are provided", () => {
			const prompt = buildSystemPrompt({
				toolSnippets: {
					read: "Read file contents",
					bash: "Execute bash commands",
					edit: "Make surgical edits",
					write: "Create or overwrite files",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- read:");
			expect(prompt).toContain("- bash:");
			expect(prompt).toContain("- edit:");
			expect(prompt).toContain("- write:");
		});

		test.each([
			[["powershell"], "Use PowerShell for file operations"],
			[["bash", "powershell"], "Use bash or PowerShell for file operations"],
		] as const)("uses shell-specific guidance for %j", (selectedTools, expected) => {
			const prompt = buildSystemPrompt({
				selectedTools: [...selectedTools],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain(expected);
		});

		test("names the package folder once and resolves pi docs and examples under it", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
				cwd: "/workspace",
			});
			const packageDir = getStablePackageDir();

			// The folder differs per installed release, so every mention is sent again after an update.
			expect(prompt.split(packageDir)).toHaveLength(2);
			expect(prompt).toContain(`- Pi package folder: ${packageDir}\n`);
			expect(prompt).toContain(
				"- Resolve README.md (main documentation), docs/... and examples/... (extensions, custom tools, SDK) under the Pi package folder, not the current working directory",
			);
			for (const path of ["README.md", "docs/codemode.md", "examples/extensions"]) {
				expect(existsSync(join(packageDir, path))).toBe(true);
			}
			expect(prompt).toContain("environment variables (docs/environment-variables.md), MCP servers (docs/mcp.md)");
			expect(prompt).toContain(
				"Before implementing harness changes, read the documentation sections and examples that cover the APIs and behavior you will change, including the references those sections depend on. Read full documents only when the change spans their scope.",
			);
		});

		test("prefers fork-release ownerSelector symlink over immutable release directory unless PI_PACKAGE_DIR is set", () => {
			const temp = mkdtempSync(join(tmpdir(), "pi-stable-pkg-"));
			const originalEnv = process.env.PI_PACKAGE_DIR;
			try {
				const releaseA = join(temp, "releases", "aaa", "pkg");
				const releaseB = join(temp, "releases", "bbb", "pkg");
				const selector = join(temp, "npm-global", "pi-coding-agent");
				mkdirSync(releaseA, { recursive: true });
				mkdirSync(releaseB, { recursive: true });
				mkdirSync(join(temp, "npm-global"), { recursive: true });
				writeFileSync(join(releaseA, "package.json"), "{}");
				writeFileSync(join(releaseB, "package.json"), "{}");
				symlinkSync(releaseA, selector);

				const receipt: ForkReleaseReceipt = {
					commit: "aaa",
					catalogSha256: "0",
					archiveSha256: "0",
					node: process.versions.node,
					npm: "10.0.0",
					platform: process.platform,
					arch: process.arch,
					validated: true,
					ownerSelector: selector,
				};

				delete process.env.PI_PACKAGE_DIR;
				expect(getStablePackageDir(releaseA, receipt)).toBe(resolve(selector));

				// Repointing the selector to a newer release keeps the same stable path.
				rmSync(selector);
				symlinkSync(releaseB, selector);
				expect(getStablePackageDir(releaseA, receipt)).toBe(resolve(selector));

				// Missing selector falls back to the concrete package directory.
				rmSync(selector);
				expect(getStablePackageDir(releaseA, receipt)).toBe(resolve(releaseA));

				// Explicit PI_PACKAGE_DIR override wins.
				symlinkSync(releaseB, selector);
				process.env.PI_PACKAGE_DIR = releaseA;
				expect(getStablePackageDir(releaseA, receipt)).toBe(resolve(releaseA));
			} finally {
				if (originalEnv === undefined) delete process.env.PI_PACKAGE_DIR;
				else process.env.PI_PACKAGE_DIR = originalEnv;
				rmSync(temp, { recursive: true, force: true });
			}
		});
	});

	describe("custom tool snippets", () => {
		test("includes custom tools in available tools section when promptSnippet is provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				toolSnippets: {
					dynamic_tool: "Run dynamic test behavior",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- dynamic_tool: Run dynamic test behavior");
		});

		test("omits custom tools from available tools section when promptSnippet is not provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("dynamic_tool");
		});
	});

	describe("prompt guidelines", () => {
		test("appends promptGuidelines to default guidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for project summaries."],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- Use dynamic_tool for project summaries.");
		});

		test("deduplicates and trims promptGuidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for summaries.", "  Use dynamic_tool for summaries.  ", "   "],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt.match(/- Use dynamic_tool for summaries\./g)).toHaveLength(1);
		});
	});

	describe("skills", () => {
		test.each([
			{ name: "default prompt", customPrompt: undefined },
			{ name: "custom prompt", customPrompt: "Custom system prompt" },
		])("includes skills with only bash in the $name", ({ customPrompt }) => {
			const prompt = buildSystemPrompt({
				customPrompt,
				selectedTools: ["bash"],
				contextFiles: [],
				skills: [testSkill],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("<skills>");
			expect(prompt).toContain("<available_skills>");
			expect(prompt).toContain("- test-skill (/skills/test-skill/SKILL.md): A test skill.");
			expect(prompt).toContain("Use bash to load a skill's file");
			expect(prompt).toContain(
				"Resolve relative paths against the skill's directory (parent of SKILL.md). Use absolute paths in tool calls.",
			);
		});

		test("omits skills without read or bash", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["write"],
				contextFiles: [],
				skills: [testSkill],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("<available_skills>");
		});
	});

	// #10343
	describe("hidden tools", () => {
		const build = (hiddenTools: string[]) =>
			buildSystemPrompt({
				selectedTools: ["read", "bash", "run"],
				hiddenTools,
				toolSnippets: { read: "Read files", bash: "Run commands", run: "Run a task" },
				toolGuidelines: { read: ["Use read for files."], run: ["Prefer run."] },
				contextFiles: [],
				skills: [testSkill],
				cwd: process.cwd(),
			});

		test("leaves hidden tools out of the tool list and rules", () => {
			const prompt = build(["read", "bash"]);

			expect(prompt).toContain("<tools>\n- run: Run a task\n");
			expect(prompt).not.toContain("- read: ");
			expect(prompt).not.toContain("Use read for files.");
			expect(prompt).not.toContain("Use bash for file operations");
			expect(prompt).toContain("- Prefer run.");
		});

		test("keeps skills without naming a hidden reader", () => {
			expect(build(["read", "bash"])).toContain("\nLoad a skill's file when the task matches its description.");
			expect(build(["read"])).toContain("Use bash to load a skill's file");
			expect(build([])).toContain("Use the read tool to load a skill's file");
		});
	});
});
