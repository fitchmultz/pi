import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createSyntheticSourceInfo } from "../../src/core/source-info.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

describe("skillExposure setting in agent session", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
	});

	function createSkillFixture(name: string, body: string, options: { disableModelInvocation?: boolean } = {}) {
		const dir = join(tmpdir(), `pi-skill-suite-${Date.now()}-${Math.random().toString(36).slice(2)}`, name);
		mkdirSync(dir, { recursive: true });
		tempDirs.push(dir);
		const filePath = join(dir, "SKILL.md");
		writeFileSync(
			filePath,
			[
				"---",
				`name: ${name}`,
				`description: Description for ${name}.`,
				...(options.disableModelInvocation ? ["disable-model-invocation: true"] : []),
				"---",
				"",
				body,
			].join("\n"),
		);
		return {
			name,
			description: `Description for ${name}.`,
			filePath,
			baseDir: dir,
			disableModelInvocation: options.disableModelInvocation ?? false,
			sourceInfo: createSyntheticSourceInfo(filePath, { source: "local", scope: "project", baseDir: dir }),
		};
	}

	it("omits manual skills from the model prompt while keeping /skill:<name> expansion working", async () => {
		const manualSkill = createSkillFixture("deploy-prod", "Follow the production deploy checklist.");
		const directSkill = createSkillFixture("code-review", "Review code thoroughly.");
		const resourceLoader = {
			...createTestResourceLoader(),
			getSkills: () => ({ skills: [manualSkill, directSkill], diagnostics: [] }),
		};

		const harness = await createHarness({
			resourceLoader,
			settings: { skillExposure: { "deploy-*": "manual" } },
		});
		harnesses.push(harness);

		let sentSystemPrompt = "";
		let expandedUserPrompt = "";
		harness.setResponses([
			(context) => {
				sentSystemPrompt = getCurrentSystemPrompt(context.messages) ?? "";
				const user = context.messages.find((message) => message.role === "user");
				expandedUserPrompt = user ? getMessageText(user) : "";
				return fauxAssistantMessage("ok");
			},
		]);

		await harness.session.prompt("/skill:deploy-prod ship v2");

		expect(sentSystemPrompt).not.toContain("deploy-prod");
		expect(sentSystemPrompt).toContain(`- code-review (${directSkill.filePath}): Description for code-review.`);
		expect(expandedUserPrompt).toContain(`<skill name="deploy-prod" location="${manualSkill.filePath}">`);
		expect(expandedUserPrompt).toContain("Follow the production deploy checklist.");
		expect(expandedUserPrompt).toContain("ship v2");
	});

	it("exposes a frontmatter disable-model-invocation skill in the model prompt when set to direct", async () => {
		const forcedDirect = createSkillFixture("incident-ops", "Handle incidents.", { disableModelInvocation: true });
		const stillHidden = createSkillFixture("secret-ops", "Secret steps.", { disableModelInvocation: true });
		const resourceLoader = {
			...createTestResourceLoader(),
			getSkills: () => ({ skills: [forcedDirect, stillHidden], diagnostics: [] }),
		};

		const harness = await createHarness({
			resourceLoader,
			settings: { skillExposure: { "incident-ops": "direct" } },
		});
		harnesses.push(harness);

		let sentSystemPrompt = "";
		harness.setResponses([
			(context) => {
				sentSystemPrompt = getCurrentSystemPrompt(context.messages) ?? "";
				return fauxAssistantMessage("ok");
			},
		]);

		await harness.session.prompt("hello");

		expect(sentSystemPrompt).toContain(`- incident-ops (${forcedDirect.filePath}): Description for incident-ops.`);
		expect(sentSystemPrompt).not.toContain("secret-ops");
	});
});
