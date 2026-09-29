import { APP_NAME } from "../config.ts";
import { convertSessionFile } from "../core/session-conversion.ts";
import { resolvePath } from "../utils/paths.ts";

/** Run before loading extensions, credentials, or session state. */
export function runSessionConversionCommand(args: string[]): boolean {
	if (args[0] !== "convert-session") return false;
	if (args.length === 2 && (args[1] === "--help" || args[1] === "-h")) {
		console.log(`Usage: ${APP_NAME} convert-session <source.jsonl> <new-output.jsonl>

Convert a settled legacy fork session into a new upstream-format journal.
The original is unchanged; an existing output is never overwritten.
Unsafe or uncertain execution history is refused. No tool or provider call runs.

Example: ${APP_NAME} convert-session old.jsonl converted.jsonl
Then resume: ${APP_NAME} --session converted.jsonl

Exit codes: 0 converted/help; 1 conversion refused or I/O failure; 2 invalid arguments.`);
		return true;
	}
	if (args.length !== 3 || args.slice(1).some((arg) => !arg || arg.startsWith("-"))) {
		console.error(`Usage: ${APP_NAME} convert-session <source.jsonl> <new-output.jsonl>`);
		process.exitCode = 2;
		return true;
	}
	try {
		const output = resolvePath(args[2]);
		convertSessionFile(resolvePath(args[1]), output);
		console.log(
			`Converted session: ${output}\nOriginal preserved. Resume with ${APP_NAME} --session ${JSON.stringify(output)}`,
		);
	} catch (error) {
		console.error(`Conversion refused: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
	return true;
}
