import { describe, expect, it } from "vitest";
import { formatSkillInvocation } from "../../src/harness/skills.ts";

describe("resource formatting helpers", () => {
	it("formats skill invocations with additional instructions", () => {
		const skill = {
			name: "inspect",
			description: "Inspect things",
			content: "Use inspection tools.",
			filePath: "/project/.pi/skills/inspect/SKILL.md",
		};

		expect(formatSkillInvocation(skill, "Check errors.")).toBe(
			'<skill name="inspect" location="/project/.pi/skills/inspect/SKILL.md">\nReferences are relative to /project/.pi/skills/inspect.\n\nUse inspection tools.\n</skill>\n\nCheck errors.',
		);
	});
});
