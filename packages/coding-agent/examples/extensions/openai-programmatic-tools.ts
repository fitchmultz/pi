/**
 * Opt-in OpenAI-hosted JavaScript with one structured, read-only tool.
 * pi -e ./openai-programmatic-tools.ts --model openai/gpt-6-sol
 * Ask: "Use a program to compare the sizes of package.json and package-lock.json."
 */
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "file_info",
		label: "File information",
		description:
			"Return a file's size in bytes and whether it is a directory. Paths are relative to the working directory.",
		parameters: Type.Object({ path: Type.String() }),
		allowedCallers: ["direct", "programmatic"],
		outputSchema: {
			type: "object",
			properties: { bytes: { type: "integer" }, directory: { type: "boolean" } },
			required: ["bytes", "directory"],
			additionalProperties: false,
		},
		async execute(_id, { path }, signal, _onUpdate, ctx) {
			signal?.throwIfAborted();
			const info = await stat(resolve(ctx.cwd, path));
			signal?.throwIfAborted();
			const result = { bytes: info.size, directory: info.isDirectory() };
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.provider !== "openai" || ctx.model.api !== "openai-responses") return;
		const payload = event.payload as ResponseCreateParamsStreaming;
		if (!payload.model?.startsWith("gpt-6-")) return;
		const tools = payload.tools ?? [];
		if (tools.some((tool) => tool.type === "programmatic_tool_calling")) return;
		return { ...payload, tools: [...tools, { type: "programmatic_tool_calling" }] };
	});
}
