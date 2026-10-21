/**
 * Codemode source format: JavaScript, optionally preceded by one options line.
 *
 * ```js
 * // @options: {"max_output_tokens": 2000, "timeout_ms": 30000}
 * const text = await tools.read({ path: "package.json" });
 * text(JSON.parse(text).name);
 * ```
 */

export const CODEMODE_OPTIONS_PREFIX = "// @options:";

const BASE_SUPPORTED_FIELDS = ["max_output_tokens", "timeout_ms"] as const;
const BACKGROUND_FIELD = "background";
/** Largest delay `setTimeout` supports, which bounds `timeout_ms`. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Lark grammar for providers with grammar-constrained tool input. It only fixes the shape of the
 * options line; the options JSON and the code are checked by {@link parseCodemodeSource}.
 */
export const CODEMODE_SOURCE_GRAMMAR = String.raw`
start: options_source | plain_source
options_source: OPTIONS_LINE NEWLINE SOURCE
plain_source: SOURCE

OPTIONS_LINE: /[ \t]*\/\/ @options:[^\r\n]*/
NEWLINE: /\r?\n/
SOURCE: /[\s\S]+/
`;

export interface CodemodeSourceOptions {
	/** Token budget for the script's output. */
	maxOutputTokens?: number;
	/** Hard deadline for the whole script in milliseconds, including tool calls. */
	timeoutMs?: number;
	/** Run detached from the tool call that started the script. Requires host support. */
	background?: boolean;
}

/** What a caller of {@link parseCodemodeSource} can do with the parsed options. */
export interface CodemodeSourceCapabilities {
	/** Accept `background`; this caller can report a result after the tool call returns. */
	background?: boolean;
}

export interface ParsedCodemodeSource {
	/** The script with the options line replaced by an empty line, so line numbers are unchanged. */
	code: string;
	options: CodemodeSourceOptions;
}

export class CodemodeSourceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CodemodeSourceError";
	}
}

function isSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseOptions(directive: string, capabilities: CodemodeSourceCapabilities): CodemodeSourceOptions {
	const fieldsSupported: readonly string[] = capabilities.background
		? [...BASE_SUPPORTED_FIELDS, BACKGROUND_FIELD]
		: BASE_SUPPORTED_FIELDS;
	const quoted = fieldsSupported.map((field) => `\`${field}\``);
	const supportedFieldsMessage = `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
	if (directive === "") {
		throw new CodemodeSourceError(`@options must be a JSON object with supported fields ${supportedFieldsMessage}`);
	}
	let value: unknown;
	try {
		value = JSON.parse(directive);
	} catch (error) {
		throw new CodemodeSourceError(
			`@options must be valid JSON with supported fields ${supportedFieldsMessage}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new CodemodeSourceError(`@options must be a JSON object with supported fields ${supportedFieldsMessage}`);
	}
	const fields = value as Record<string, unknown>;
	for (const key of Object.keys(fields)) {
		if (!fieldsSupported.includes(key)) {
			throw new CodemodeSourceError(`@options only supports ${supportedFieldsMessage}; got \`${key}\``);
		}
	}
	const options: CodemodeSourceOptions = {};
	const { max_output_tokens, timeout_ms, background } = fields;
	if (max_output_tokens !== undefined) {
		if (!isSafeInteger(max_output_tokens)) {
			throw new CodemodeSourceError("@options field `max_output_tokens` must be a non-negative safe integer");
		}
		options.maxOutputTokens = max_output_tokens;
	}
	if (timeout_ms !== undefined) {
		if (!isSafeInteger(timeout_ms) || timeout_ms === 0 || timeout_ms > MAX_TIMEOUT_MS) {
			throw new CodemodeSourceError(
				`@options field \`timeout_ms\` must be a positive integer up to ${MAX_TIMEOUT_MS}`,
			);
		}
		options.timeoutMs = timeout_ms;
	}
	if (background !== undefined) {
		if (typeof background !== "boolean") {
			throw new CodemodeSourceError("@options field `background` must be a boolean");
		}
		options.background = background;
	}
	return options;
}

/**
 * Split an optional first-line `// @options: {...}` from the script. Throws
 * {@link CodemodeSourceError} for empty input, invalid options, and an options line that is not the
 * first line, which would otherwise be ignored without notice. `capabilities` widens the accepted
 * fields; callers that cannot run a script after the tool call returns leave `background` out.
 */
export function parseCodemodeSource(
	input: string,
	capabilities: CodemodeSourceCapabilities = {},
): ParsedCodemodeSource {
	if (input.trim() === "") {
		throw new CodemodeSourceError(
			'Expected JavaScript source text (non-empty). Provide JS only, optionally with a first line `// @options: {"max_output_tokens": 1000}`.',
		);
	}
	const lines = input.split("\n");
	const misplaced = lines.findIndex(
		(line, index) => index > 0 && line.trimStart().startsWith(CODEMODE_OPTIONS_PREFIX),
	);
	if (misplaced !== -1) {
		throw new CodemodeSourceError(
			`The ${CODEMODE_OPTIONS_PREFIX} line must be the first line of the input; found one on line ${misplaced + 1}`,
		);
	}
	const newline = input.indexOf("\n");
	const firstLine = lines[0].replace(/\r$/, "");
	const trimmed = firstLine.trimStart();
	if (!trimmed.startsWith(CODEMODE_OPTIONS_PREFIX)) return { code: input, options: {} };
	const code = newline === -1 ? "" : input.slice(newline);
	if (code.trim() === "") {
		throw new CodemodeSourceError("The @options line must be followed by JavaScript source on subsequent lines");
	}
	return { code, options: parseOptions(trimmed.slice(CODEMODE_OPTIONS_PREFIX.length).trim(), capabilities) };
}
