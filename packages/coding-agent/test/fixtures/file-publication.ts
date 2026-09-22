import { BACKGROUND_CONTEXT } from "../../../agent/src/harness/context.ts";
import { NodeExecutionEnv } from "../../../agent/src/harness/env/nodejs.ts";
import { createEditTool as createHarnessEditTool } from "../../../agent/src/harness/tools/edit.ts";
import { createWriteTool as createHarnessWriteTool } from "../../../agent/src/harness/tools/write.ts";
import { getOrThrow } from "../../../agent/src/harness/types.ts";
import { createEditTool } from "../../src/core/tools/edit.ts";
import { createWriteTool } from "../../src/core/tools/write.ts";

const [kind, path, mode] = process.argv.slice(2);
if (mode === "handled") process.on("SIGXFSZ", () => {});
const replacement = "N".repeat(8192);
const env = new NodeExecutionEnv({ cwd: process.cwd() });
const invocation = {
	invocationId: "test",
	operationId: "test",
	turnId: "test",
	getMemo: async () => undefined,
	setMemo: async () => {},
};
try {
	switch (kind) {
		case "write":
			await createWriteTool(process.cwd()).execute("test", { path, content: replacement });
			break;
		case "edit":
			await createEditTool(process.cwd()).execute("test", {
				path,
				edits: [{ oldText: "original", newText: replacement }],
			});
			break;
		case "env":
			getOrThrow(await env.writeFile(path, replacement, BACKGROUND_CONTEXT));
			break;
		case "harness-write":
			await createHarnessWriteTool().execute(
				"test",
				{ path, content: replacement },
				() => {},
				{ env },
				invocation,
				BACKGROUND_CONTEXT,
			);
			break;
		case "harness-edit":
			await createHarnessEditTool().execute(
				"test",
				{ path, edits: [{ oldText: "original", newText: replacement }] },
				() => {},
				{ env },
				invocation,
				BACKGROUND_CONTEXT,
			);
			break;
		default:
			throw new Error(`Unknown route: ${kind}`);
	}
	console.log(JSON.stringify({ success: true }));
} catch (error) {
	const messages: string[] = [];
	for (let cause = error; cause instanceof Error; cause = cause.cause) {
		messages.push(cause.message);
	}
	console.log(JSON.stringify({ success: false, error: messages.join("; ") }));
}
