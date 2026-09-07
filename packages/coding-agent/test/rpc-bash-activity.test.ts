import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

it("exposes async RPC Bash and nextTurn activity without dispatching twice", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-rpc-activity-"));
	const fixture = join(root, "fixture.ts");
	writeFileSync(
		fixture,
		`
export default function (pi) {
	let release = () => {};
	let calls = 0;
	let later = 0;
	pi.on("user_bash", async () => {
		calls++;
		await new Promise(resolve => { release = resolve; });
		return { result: { output: "intercepted RPC result", exitCode: 0, cancelled: false, truncated: false } };
	});
	pi.on("user_bash", () => { later++; });
	pi.registerCommand("aside", { handler: async () => {
		pi.sendMessage({ customType: "aside", content: "pending context", display: false }, { deliverAs: "nextTurn" });
	} });
	pi.registerCommand("activity", { handler: async (_args, ctx) => {
		pi.appendEntry("activity", { bash: ctx.isBashRunning(), nextTurn: ctx.getPendingNextTurnCount(), idle: ctx.isIdle(), pending: ctx.hasPendingMessages(), calls, later });
	} });
	pi.registerCommand("release", { handler: async () => release() });
}
`,
	);
	const client = new RpcClient({
		cliPath: process.env.PI_TEST_CLI ?? resolve(__dirname, "../src/cli.ts"),
		cwd: root,
		env: {
			HOME: root,
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
			"--no-tools",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-extensions",
			"--no-session",
			"--extension",
			fixture,
		],
	});
	let pending: ReturnType<RpcClient["bash"]> | undefined;
	try {
		await client.start();
		await client.prompt("/aside");
		pending = client.bash("must not execute locally");
		void pending.catch(() => {});
		await client.prompt("/activity");
		expect((await client.getEntries()).entries.at(-1)).toMatchObject({
			type: "custom",
			customType: "activity",
			data: { bash: true, nextTurn: 1, idle: true, pending: false, calls: 1, later: 0 },
		});
		await client.prompt("/release");
		expect(await pending).toMatchObject({ output: "intercepted RPC result", exitCode: 0 });
		await client.clearQueue();
		await client.prompt("/activity");
		expect((await client.getEntries()).entries.at(-1)).toMatchObject({
			data: { bash: false, nextTurn: 1, idle: true, pending: false, calls: 1, later: 0 },
		});
		expect((await client.getMessages()).filter((message) => message.role === "bashExecution")).toHaveLength(1);
	} finally {
		await client.stop();
		await pending?.catch(() => {});
		rmSync(root, { recursive: true, force: true });
	}
});
