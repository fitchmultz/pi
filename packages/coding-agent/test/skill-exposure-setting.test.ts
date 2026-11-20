import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { Compile } from "typebox/compile";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { type CreateAgentSessionOptions, createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { type Settings, SettingsManager } from "../src/core/settings-manager.ts";
import { SettingsSchema } from "../src/core/settings-schema.ts";
import { openWorkingSession, parseWorkingSession } from "../src/core/working-session.ts";

describe("skillExposure setting", () => {
	let tempDir: string;
	let agentDir: string;
	const sessions: AgentSession[] = [];

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-skill-exposure-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(tempDir, ".pi"), { recursive: true });
	});

	afterEach(() => {
		while (sessions.length > 0) sessions.pop()?.dispose();
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	const model = () => getModel("anthropic", "claude-sonnet-4-5")!;
	const writeGlobal = (settings: Settings) => writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
	const writeProject = (settings: Settings) =>
		writeFileSync(join(tempDir, ".pi", "settings.json"), JSON.stringify(settings));

	function writeSkill(
		root: string,
		name: string,
		description: string,
		options: { disableModelInvocation?: boolean } = {},
	): string {
		const dir = join(root, name);
		mkdirSync(dir, { recursive: true });
		const filePath = join(dir, "SKILL.md");
		const frontmatter = [
			"---",
			`name: ${name}`,
			`description: ${description}`,
			...(options.disableModelInvocation ? ["disable-model-invocation: true"] : []),
			"---",
			"",
			`# ${name}`,
			"",
			`Body for ${name}.`,
		].join("\n");
		writeFileSync(filePath, frontmatter);
		return filePath;
	}

	async function createSession(settingsManager: SettingsManager) {
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: model(),
			settingsManager,
			sessionManager: SessionManager.inMemory(tempDir),
			resourceLoader,
		});
		sessions.push(session);
		return session;
	}

	describe("SettingsManager.getSkillExposure", () => {
		it("gives a skill the entry with its exact name, else the first matching pattern", () => {
			const manager = SettingsManager.inMemory({
				skillExposure: { "internal-*": "manual", "*": "direct", "internal-deploy": "direct" },
			});

			expect(manager.getSkillExposure("internal-deploy")).toBe("direct");
			expect(manager.getSkillExposure("internal-audit")).toBe("manual");
			expect(manager.getSkillExposure("other-skill")).toBe("direct");
			// Property names every object inherits are not entries.
			expect(
				SettingsManager.inMemory({ skillExposure: { release: "manual" } }).getSkillExposure("constructor"),
			).toBeUndefined();
			expect(SettingsManager.inMemory().getSkillExposure("release")).toBeUndefined();
		});

		it("matches the entries of an overriding layer before inherited ones", () => {
			writeGlobal({ skillExposure: { "ops-*": "manual", release: "manual", review: "manual" } });
			writeProject({ skillExposure: { "ops-db-*": "direct", release: "direct" } });

			const manager = SettingsManager.create(tempDir, agentDir);
			expect(manager.getSkillExposure("ops-db-migrate")).toBe("direct");
			expect(manager.getSkillExposure("ops-deploy")).toBe("manual");
			expect(manager.getSkillExposure("release")).toBe("direct");
			expect(manager.getSkillExposure("review")).toBe("manual");

			manager.applyOverrides({ skillExposure: { "ops-db-m*": "manual", review: "direct" } });
			expect(manager.getSkillExposure("ops-db-migrate")).toBe("manual");
			expect(manager.getSkillExposure("ops-db-backup")).toBe("direct");
			expect(manager.getSkillExposure("review")).toBe("direct");
		});

		it("ignores project skillExposure when the project is untrusted", () => {
			writeGlobal({ skillExposure: { release: "manual" } });
			writeProject({ skillExposure: { release: "direct" } });

			const manager = SettingsManager.create(tempDir, agentDir, { projectTrusted: false });
			expect(manager.getSkillExposure("release")).toBe("manual");
		});

		it("ignores malformed values and validates against SettingsSchema", () => {
			expect(
				SettingsManager.inMemory({ skillExposure: { release: "hidden" } } as unknown as Settings).getSkillExposure(
					"release",
				),
			).toBeUndefined();
			expect(
				SettingsManager.inMemory({ skillExposure: ["release"] } as unknown as Settings).getSkillExposure("0"),
			).toBeUndefined();

			const validator = Compile(SettingsSchema);
			expect(validator.Check({ skillExposure: { release: "manual", "ops-*": "direct" } })).toBe(true);
			expect(validator.Check({ skillExposure: { release: "deferred" } })).toBe(false);
		});
	});

	describe("AgentSession integration", () => {
		it("omits manual skills without mutating ResourceLoader and overrides frontmatter disable-model-invocation", async () => {
			const skillsRoot = join(agentDir, "skills");
			writeSkill(skillsRoot, "ops-deploy", "Deploy services.");
			writeSkill(skillsRoot, "ops-secret", "Secret runbook.", { disableModelInvocation: true });
			writeSkill(skillsRoot, "ops-hidden", "Hidden runbook.", { disableModelInvocation: true });

			writeGlobal({
				skillExposure: {
					"ops-deploy": "manual",
					"ops-secret": "direct",
				},
			});

			const session = await createSession(SettingsManager.create(tempDir, agentDir));

			expect(session.systemPrompt).not.toContain("ops-deploy");
			expect(session.systemPrompt).toContain("- ops-secret (");
			expect(session.systemPrompt).not.toContain("ops-hidden");

			// ResourceLoader keeps original skill definitions unmutated so /skill:<name> and autocomplete stay intact.
			const loaderSkills = session.resourceLoader.getSkills().skills;
			expect(loaderSkills.find((s) => s.name === "ops-deploy")?.disableModelInvocation).toBe(false);
			expect(loaderSkills.find((s) => s.name === "ops-secret")?.disableModelInvocation).toBe(true);
			expect(loaderSkills.find((s) => s.name === "ops-hidden")?.disableModelInvocation).toBe(true);
		});

		it("applies project overrides and picks up changes on reload", async () => {
			const skillsRoot = join(agentDir, "skills");
			writeSkill(skillsRoot, "alpha", "Alpha skill.");
			writeSkill(skillsRoot, "beta", "Beta skill.", { disableModelInvocation: true });

			writeGlobal({ skillExposure: { alpha: "manual" } });
			const session = await createSession(SettingsManager.create(tempDir, agentDir));
			expect(session.systemPrompt).not.toContain("alpha");
			expect(session.systemPrompt).not.toContain("beta");

			// Project setting restores alpha and exposes frontmatter-disabled beta.
			writeProject({ skillExposure: { alpha: "direct", beta: "direct" } });
			await session.reload();
			expect(session.systemPrompt).toContain("- alpha: Alpha skill.");
			expect(session.systemPrompt).toContain("- beta: Beta skill.");

			// Clearing project setting reverts to global skillExposure on reload.
			writeProject({});
			await session.reload();
			expect(session.systemPrompt).not.toContain("alpha");
			expect(session.systemPrompt).not.toContain("beta");
		});

		it("applies overrides through session services, drops them on reload, and round-trips working sessions", async () => {
			const skillsRoot = join(agentDir, "skills");
			writeSkill(skillsRoot, "alpha", "Alpha skill.");
			writeSkill(skillsRoot, "beta", "Beta skill.");

			const createServices = (workingSession?: CreateAgentSessionOptions["workingSession"]) =>
				createAgentSessionServices({
					cwd: tempDir,
					agentDir,
					settingsManager: SettingsManager.create(tempDir, agentDir),
					workingSession,
				});

			writeGlobal({ skillExposure: { alpha: "manual" } });
			const services = await createServices();
			services.settingsManager.applyOverrides({ skillExposure: { beta: "manual" } });
			const { session: initial } = await createAgentSessionFromServices({
				services,
				sessionManager: SessionManager.inMemory(tempDir),
				model: model(),
			});
			sessions.push(initial);

			expect(initial.systemPrompt).not.toContain("alpha");
			expect(initial.systemPrompt).not.toContain("beta");

			// Working session preserves the effective settings including transient overrides.
			const hold = await initial.acquireWorkingSession();
			const saved = parseWorkingSession(JSON.stringify(hold.state));
			await hold.release();
			expect(saved.settings.skillExposure).toEqual({ beta: "manual", alpha: "manual" });

			const { session: restored } = await createAgentSessionFromServices({
				services: await createServices(saved),
				sessionManager: openWorkingSession(saved),
				workingSession: saved,
			});
			sessions.push(restored);
			expect(restored.systemPrompt).not.toContain("alpha");
			expect(restored.systemPrompt).not.toContain("beta");

			// Reloading the file-backed session drops transient overrides so beta becomes visible again.
			await initial.reload();
			expect(initial.systemPrompt).not.toContain("alpha");
			expect(initial.systemPrompt).toContain("- beta (");
		});
	});
});
