import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

it("runs extension startup once for each RPC session replacement", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-rpc-session-start-"));
	const tracePath = join(root, "starts.jsonl");
	const extensionPath = join(root, "startup.ts");
	writeFileSync(
		extensionPath,
		`
import { appendFileSync } from "node:fs";
export default function (pi) {
	pi.on("session_start", (event, ctx) => {
		appendFileSync(${JSON.stringify(tracePath)}, JSON.stringify({ reason: event.reason, sessionId: ctx.sessionManager.getSessionId() }) + "\\n");
		pi.appendEntry("startup-action", { reason: event.reason });
		if (event.reason === "startup") ctx.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
	});
}
`,
	);
	const client = new RpcClient({
		cliPath: process.env.PI_TEST_CLI ?? resolve(__dirname, "../src/cli.ts"),
		cwd: root,
		env: {
			PI_CODING_AGENT_DIR: join(root, "agent"),
			PI_OFFLINE: "1",
			NODE_OPTIONS: process.env.PI_TEST_CLI
				? ""
				: `--import=${JSON.stringify(resolve(__dirname, "../src/experimental/source-resolver.ts"))}`,
		},
		args: [
			"--offline",
			"--no-approve",
			"--no-context-files",
			"--no-extensions",
			"--extension",
			extensionPath,
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-tools",
			"--session-dir",
			join(root, "sessions"),
		],
	});
	const starts = () =>
		readFileSync(tracePath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { reason: string; sessionId: string });
	try {
		await client.start();
		const original = await client.getState();
		const originalEntries = await client.getEntries();
		const seed = originalEntries.entries.find((entry) => entry.type === "message" && entry.message.role === "user");
		expect(seed).toBeDefined();
		expect(starts()).toEqual([{ reason: "startup", sessionId: original.sessionId }]);

		expect(await client.newSession()).toEqual({ cancelled: false });
		const created = await client.getState();
		expect(created.sessionId).not.toBe(original.sessionId);
		expect(starts()).toEqual([
			{ reason: "startup", sessionId: original.sessionId },
			{ reason: "new", sessionId: created.sessionId },
		]);
		expect(
			(await client.getEntries()).entries.filter(
				(entry) => entry.type === "custom" && entry.customType === "startup-action",
			),
		).toHaveLength(1);

		expect(await client.switchSession(original.sessionFile!)).toEqual({ cancelled: false });
		expect((await client.getState()).sessionId).toBe(original.sessionId);
		expect(starts().at(-1)).toEqual({ reason: "resume", sessionId: original.sessionId });
		expect(starts()).toHaveLength(3);

		expect(await client.fork(seed!.id)).toEqual({ text: "seed", cancelled: false });
		const forked = await client.getState();
		expect(starts().at(-1)).toEqual({ reason: "fork", sessionId: forked.sessionId });
		expect(starts()).toHaveLength(4);

		expect(await client.clone()).toEqual({ cancelled: false });
		const cloned = await client.getState();
		expect(cloned.sessionId).not.toBe(forked.sessionId);
		expect(starts().at(-1)).toEqual({ reason: "fork", sessionId: cloned.sessionId });
		expect(starts()).toHaveLength(5);
	} finally {
		await client.stop();
		rmSync(root, { recursive: true, force: true });
	}
});
