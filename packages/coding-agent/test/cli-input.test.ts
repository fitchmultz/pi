import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const cliArgs = process.env.PI_TEST_CLI
	? [process.env.PI_TEST_CLI]
	: [
			"--import",
			fileURLToPath(new URL("../src/experimental/source-resolver.ts", import.meta.url)),
			fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
		];

test.for([
	{ input: "  界😀\r\n    next\r\n", messages: [], expected: ["  界😀\r\n    next\r\n"] },
	{ input: "  42\n", messages: ["Explain"], expected: ["  42\n\n\nExplain"] },
	{ input: " \n\t", messages: [], expected: [] },
	{ input: "PIPE\n", messages: ["FIRST", "SECOND"], expected: undefined },
])("preserves piped input and prompt boundaries: $input", ({ input, messages, expected }, { onTestFinished }) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-cli-input-")));
	onTestFinished(() => rmSync(root, { recursive: true, force: true }));
	const home = join(root, "home");
	mkdirSync(home);
	const capture = join(root, "prompts.json");
	const extension = join(root, "observe.ts");
	writeFileSync(
		extension,
		`import { writeFileSync } from "node:fs";
import { fauxProvider, fauxAssistantMessage, type FauxResponseFactory } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function(pi: ExtensionAPI) {
	const prompts: string[] = [];
	const faux = fauxProvider();
	const reply: FauxResponseFactory = (context) => {
		const message = context.messages.filter((entry) => entry.role === "user").at(-1);
		const content = message?.content ?? "";
		prompts.push(typeof content === "string" ? content : content.filter((part) => part.type === "text").map((part) => part.text).join(""));
		return fauxAssistantMessage("ok");
	};
	faux.setResponses([reply, reply]);
	pi.registerProvider("faux", {
		api: faux.api, baseUrl: faux.getModel().baseUrl, apiKey: "faux-key",
		models: faux.models, streamSimple: faux.provider.streamSimple,
	});
	pi.on("session_shutdown", () => writeFileSync(${JSON.stringify(capture)}, JSON.stringify(prompts)));
}
`,
	);
	const attachment = join(root, "attached.txt");
	const fileArgs = expected === undefined ? [`@${attachment}`] : [];
	if (fileArgs.length) writeFileSync(attachment, "Attached");
	execFileSync(
		process.execPath,
		[
			...cliArgs,
			"--offline",
			"--no-session",
			"--no-tools",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
			"--no-approve",
			"-e",
			extension,
			"--provider",
			"faux",
			"--model",
			"faux-1",
			"--print",
			...fileArgs,
			...messages,
		],
		{
			cwd: root,
			input,
			encoding: "utf8",
			timeout: 30_000,
			env: {
				PATH: process.env.PATH,
				SystemRoot: process.env.SystemRoot,
				HOME: home,
				USERPROFILE: home,
				PI_CODING_AGENT_DIR: join(home, "agent"),
				PI_OFFLINE: "1",
				PI_TELEMETRY: "0",
			},
		},
	);
	expect(JSON.parse(readFileSync(capture, "utf8"))).toEqual(
		expected ?? [`PIPE\n\n\n<file name="${attachment}">\nAttached\n</file>\n\n\nFIRST`, "SECOND"],
	);
});
