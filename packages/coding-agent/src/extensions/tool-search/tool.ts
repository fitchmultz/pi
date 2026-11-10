/**
 * Tool discovery: a BM25 ranker over tool metadata, shared by `searchTools()` in codemode scripts and
 * the optional `tool_search` tool.
 *
 * `tool_search` searches the tools that are declared to the model only once loaded (`codemode` and
 * `deferred` exposure) and loads the good matches, so they are declared for the next model call. It
 * lists weaker matches without loading them, and says when the query names a tool that is already
 * active or that it cannot load. Loading goes through the active tool set, so it is recorded in the
 * transcript like any other tool change and survives `/tree`, resume, and fork on that branch.
 */

import { resolveSchemaRef } from "@earendil-works/pi-codemode/declarations";
import { type Static, Type } from "typebox";
import type {
	ExtensionAPI,
	ToolDefinition,
	ToolExposure,
	ToolInfo,
	ToolNamespace,
} from "../../core/extensions/types.ts";

export const TOOL_SEARCH_TOOL_NAME = "tool_search";
export const DEFAULT_TOOL_SEARCH_LIMIT = 8;

/** A tool as the ranker sees it: its name and the texts built by {@link createToolSearchDocument}. */
export interface ToolSearchDocument {
	name: string;
	/** Description, schema descriptions, and property names. */
	text: string;
	/** Name of the tool's namespace, for example `mcp__docs`. */
	namespaceName?: string;
	/** Name, description, and instructions of the tool's namespace. */
	namespaceText?: string;
}

export interface ToolSearchMatch {
	name: string;
	score: number;
	/**
	 * Whether the tool is a good match, not one that only shares words with the query. The query names
	 * it, or enough of the query's terms are the tool's own, that is, in its name, its description and
	 * schema, or its namespace name: all of them, or more than half when one is in a name. A long
	 * description mentions many words, so some of them say little. A query that only names tools has no
	 * other good match: `mcp__app__thread_read` does not make `mcp__app__thread_list` one.
	 */
	strong: boolean;
}

/** Ranks tools for a query. BM25 today; a hybrid ranker with embeddings can replace it. */
export interface ToolRanker {
	rank(query: string, documents: readonly ToolSearchDocument[], limit: number): ToolSearchMatch[];
}

const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

const STOP_WORDS: ReadonlySet<string> = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"by",
	"for",
	"from",
	"in",
	"is",
	"it",
	"of",
	"on",
	"or",
	"that",
	"the",
	"this",
	"to",
	"with",
]);

/** Naive singular form, so `issues` matches `issue` and `searches` matches `search`. */
function stem(term: string): string {
	if (term.length > 4 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
	if (term.length > 4 && /(ches|shes|sses|xes|zes)$/.test(term)) return term.slice(0, -2);
	if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss")) return term.slice(0, -1);
	return term;
}

/** Unicode word segmentation with identifier boundaries and English stop words/singular forms. */
export function tokenize(text: string): string[] {
	const normalized = text
		.normalize("NFC")
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.toLowerCase()
		.replace(/[^\p{L}\p{M}\p{N}]+/gu, " ");
	// The segmenter costs about 15 times a split. Plain ASCII splits into the same words at spaces, so only other
	// text, such as Chinese written without spaces, goes through it.
	const words = /^[a-z0-9 ]*$/.test(normalized)
		? normalized.split(" ")
		: Array.from(wordSegmenter.segment(normalized), (segment) => (segment.isWordLike ? segment.segment : ""));
	return words
		.filter((word) => word.length > 0 && !STOP_WORDS.has(word))
		.map((word) => (/^[a-z0-9]+$/.test(word) ? stem(word) : word));
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Schema descriptions and property names, recursively, following local `$ref`s into `root`. `seen` holds the
 * subschemas already reached through a reference, so recursive and shared definitions are read once, and
 * definitions no property references are not read.
 */
function schemaText(schema: unknown, root: unknown, parts: string[], seen: Set<unknown>): void {
	if (!isObject(schema)) return;
	if (typeof schema.$ref === "string") {
		const target = resolveSchemaRef(schema.$ref, root);
		if (isObject(target) && !seen.has(target)) {
			seen.add(target);
			schemaText(target, root, parts, seen);
		}
	}
	if (typeof schema.description === "string") parts.push(schema.description);
	if (isObject(schema.properties)) {
		for (const [name, property] of Object.entries(schema.properties)) {
			parts.push(name);
			schemaText(property, root, parts, seen);
		}
	}
	schemaText(schema.items, root, parts, seen);
	for (const key of ["anyOf", "oneOf", "allOf"]) {
		const variants = schema[key];
		if (Array.isArray(variants)) for (const variant of variants) schemaText(variant, root, parts, seen);
	}
}

/**
 * Search text of a tool: the description and the schema descriptions and property names, and
 * separately the namespace name, description, and instructions. The ranker reads the name from `name`.
 */
export function createToolSearchDocument(
	tool: Pick<ToolInfo, "name" | "description" | "parameters">,
	namespace?: ToolNamespace,
): ToolSearchDocument {
	const parts = [tool.description];
	schemaText(tool.parameters, tool.parameters, parts, new Set([tool.parameters]));
	const namespaceText = namespace
		? [namespace.name, namespace.description ?? "", namespace.instructions ?? ""].join(" ")
		: "";
	return {
		name: tool.name,
		text: parts.filter((part) => part.trim()).join(" "),
		namespaceName: namespace?.name,
		namespaceText,
	};
}

/** Lowercase with characters invalid in script identifiers as `_`, so `dev-radius` matches `dev_radius`. */
function normalizeName(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_$]/g, "_");
}

/**
 * Whether `query` is the tool's name: its full name or a suffix after a `__` separator, so
 * `thread_read` and `app__thread_read` both name `mcp__app__thread_read`. A `__` separator may be
 * written `_`, as models do: `app_thread_read` and `app thread read` name it too.
 */
function isExactNameQuery(query: string, name: string): boolean {
	const single = (text: string) => text.replace(/_+/g, "_");
	const wanted = single(query);
	const segments = normalizeName(name).split("__");
	return segments.some((_, index) => single(segments.slice(index).join("__")) === wanted);
}

/** A query word that names a tool or a server instead of describing one. */
interface NameWord {
	/** The word without its `+` and the punctuation around it. */
	text: string;
	/** Its search terms. A name contains the word when it has them all. */
	terms: readonly string[];
	/** Written `+word`: a tool is a match only if its name or its namespace name contains the word. */
	required: boolean;
}

/** Leading and trailing characters that are not part of a word, such as `+`, quotes, and commas. */
const NAME_EDGES = /^[^\p{L}\p{M}\p{N}_$]+|[^\p{L}\p{M}\p{N}_$]+$/gu;

/**
 * The words of a query that name a tool or a server: each `+word`, each word with an underscore, as
 * tool names are written, and the query itself when it is one word.
 */
function nameWords(query: string): NameWord[] {
	const words = query.trim().split(/\s+/);
	return words.flatMap((word) => {
		const text = word.replace(NAME_EDGES, "");
		const required = word.startsWith("+");
		if (!required && !text.includes("_") && words.length > 1) return [];
		const terms = tokenize(text);
		return terms.length === 0 ? [] : [{ text, terms, required }];
	});
}

/** Whether the query names the tool: as a whole, or with one of its name words. */
function namesTool(query: string, words: readonly NameWord[], name: string): boolean {
	return (
		isExactNameQuery(normalizeName(query.trim().replace(NAME_EDGES, "")), name) ||
		words.some((word) => isExactNameQuery(normalizeName(word.text), name))
	);
}

/** A document split into the fields the ranker weighs differently. */
interface IndexedDocument {
	name: string;
	/** Terms of the name, for example `mcp`, `app`, `thread`, `read` for `mcp__app__thread_read`. */
	nameTerms: ReadonlySet<string>;
	/** Terms of the last `__` segment of the name, the part models say: `thread`, `read`. */
	localNameTerms: readonly string[];
	textCounts: ReadonlyMap<string, number>;
	textLength: number;
	/** Terms of the namespace name, for example `mcp`, `app` for `mcp__app`. */
	namespaceNameTerms: ReadonlySet<string>;
	namespaceTerms: ReadonlySet<string>;
}

function indexDocument(document: ToolSearchDocument): IndexedDocument {
	const textCounts = new Map<string, number>();
	for (const term of tokenize(document.text)) textCounts.set(term, (textCounts.get(term) ?? 0) + 1);
	const segments = document.name.split("__");
	return {
		name: document.name,
		nameTerms: new Set(tokenize(document.name)),
		localNameTerms: [...new Set(tokenize(segments[segments.length - 1]))],
		textCounts,
		textLength: [...textCounts.values()].reduce((sum, count) => sum + count, 0),
		namespaceNameTerms: new Set(tokenize(document.namespaceName ?? "")),
		namespaceTerms: new Set(tokenize(document.namespaceText ?? "")),
	};
}

/**
 * A query term in the name counts this many times its IDF. The text part of a term is at most
 * `k1 + 1` (2.2) times its IDF and about 1 for a single mention, so a name match beats any number of
 * mentions in the description.
 */
const NAME_WEIGHT = 3;

/**
 * A query term in the namespace name, description, or instructions counts this many times its IDF. They
 * are shared by every tool of the server, so they help find the server but not the tool in it.
 */
const NAMESPACE_WEIGHT = 0.5;

/**
 * Okapi BM25 over the description, with the name and the namespace as separate fields:
 * - a `+word` in the query is a requirement: only tools whose name or namespace name contains the
 *   word are matches;
 * - a good match (see {@link ToolSearchMatch.strong}) ranks above the others. The namespace
 *   description and instructions do not make a tool a good match: every tool of the server shares
 *   them;
 * - then a tool that matches more of the query's terms, in any field, ranks above one that matches
 *   fewer, whatever their scores: for `screenshot window`, a tool whose description has both words
 *   beats `window`, whose name has one;
 * - a query term in the name scores more than any number of mentions in the description;
 * - a tool whose whole local name is in the query (`app` in `peekaboo app` for
 *   `mcp__peekaboo__app`) gets a bonus worth one more match of every query term, so among tools
 *   matching as many terms it mostly wins over tools that only mention the words;
 * - a query that names a tool ranks that tool first, before coverage: the whole query is its name, or
 *   one of its words is and is written as a name (`+word`, or with an underscore).
 *
 * The description alone is length-normalized, so a long name or long namespace instructions do
 * not lower a tool's score. Ties keep document order.
 */
export class Bm25Ranker implements ToolRanker {
	private readonly k1: number;
	private readonly b: number;

	constructor(options: { k1?: number; b?: number } = {}) {
		this.k1 = options.k1 ?? 1.2;
		this.b = options.b ?? 0.75;
	}

	rank(query: string, documents: readonly ToolSearchDocument[], limit: number): ToolSearchMatch[] {
		const queryTerms = new Set(tokenize(query));
		if (queryTerms.size === 0 || documents.length === 0 || limit <= 0) return [];
		const names = nameWords(query);
		const required = names.filter((word) => word.required);
		const indexed = documents.map(indexDocument);
		const averageLength = indexed.reduce((sum, document) => sum + document.textLength, 0) / indexed.length || 1;
		const idf = new Map(
			[...queryTerms].map((term) => {
				const frequency = indexed.filter(
					(document) =>
						document.nameTerms.has(term) || document.textCounts.has(term) || document.namespaceTerms.has(term),
				).length;
				return [term, Math.log(1 + (indexed.length - frequency + 0.5) / (frequency + 0.5))] as const;
			}),
		);
		const fullNameBonus = [...idf.values()].reduce((sum, value) => sum + value, 0);
		const named = indexed.filter((document) => namesTool(query, names, document.name));
		// Every term belongs to the name of a tool the query names: the query names tools and describes none.
		const onlyNames =
			named.length > 0 && [...queryTerms].every((term) => named.some((document) => document.nameTerms.has(term)));
		const matches: (ToolSearchMatch & { covered: number; exact: boolean })[] = [];
		for (const document of indexed) {
			const inName = (term: string) => document.nameTerms.has(term) || document.namespaceNameTerms.has(term);
			if (!required.every((word) => word.terms.every(inName))) continue;
			const norm = this.k1 * (1 - this.b + (this.b * document.textLength) / averageLength);
			let score = 0;
			let covered = 0;
			let own = 0;
			let inNames = 0;
			for (const term of queryTerms) {
				const count = document.textCounts.get(term) ?? 0;
				const weight =
					(document.nameTerms.has(term) ? NAME_WEIGHT : 0) +
					(document.namespaceTerms.has(term) ? NAMESPACE_WEIGHT : 0) +
					(count * (this.k1 + 1)) / (count + norm);
				if (weight > 0) covered++;
				if (count > 0 || inName(term)) own++;
				if (inName(term)) inNames++;
				score += (idf.get(term) ?? 0) * weight;
			}
			if (score === 0) continue;
			const local = document.localNameTerms;
			if (local.length > 0 && local.every((term) => queryTerms.has(term))) score += fullNameBonus;
			const exact = named.includes(document);
			const most = own === queryTerms.size || (inNames > 0 && own * 2 > queryTerms.size);
			const strong = exact || (!onlyNames && most);
			matches.push({ name: document.name, score, covered, exact, strong });
		}
		return matches
			.sort(
				(a, b) =>
					Number(b.exact) - Number(a.exact) ||
					Number(b.strong) - Number(a.strong) ||
					b.covered - a.covered ||
					b.score - a.score,
			)
			.slice(0, limit)
			.map(({ name, score, strong }) => ({ name, score, strong }));
	}
}

export const toolSearchSchema = Type.Object({
	query: Type.String({ description: "Search query for deferred tools." }),
	limit: Type.Optional(
		Type.Number({ description: `Maximum number of tools to return. Defaults to ${DEFAULT_TOOL_SEARCH_LIMIT}.` }),
	),
});

export type ToolSearchInput = Static<typeof toolSearchSchema>;

export interface ToolSearchToolDetails {
	/** Tools loaded by this call. */
	loaded: string[];
	/** The closest matches that the result lists when none is good. Not loaded. */
	listed?: string[];
	/** Tools that were already active: good matches, and tools named in the query. */
	active?: string[];
	/** Names in the query that `tool_search` cannot load: a tool it does not search, or no tool or server at all. */
	unavailable?: string[];
}

export interface ToolSearchToolOptions {
	/**
	 * The session's tools. `tool_search` searches the tools that are declared to the model only once
	 * loaded and activates the good matches. Without it, the tool finds nothing. An `ExtensionAPI` fits.
	 */
	tools?: Pick<ExtensionAPI, "getAllTools" | "getActiveTools" | "setActiveTools">;
}

/** What one search found. */
interface ToolSearchOutcome {
	/** Good matches that were not active, best first: loaded by this call. */
	loaded: ToolInfo[];
	/** The best matches when none is good, with whether each is active. Not loaded. */
	closest: { tool: ToolInfo; active: boolean }[];
	/** Tools that are already active: good matches, and tools named in the query. */
	active: string[];
	/** Tools named in the query that are registered but that `tool_search` does not search. */
	notOffered: string[];
	/** Name words of the query that no tool name and no namespace name of the session contains. */
	unknown: string[];
}

/** Whether `tool_search` can load a tool with this exposure. */
function isSearchable(exposure: ToolExposure): boolean {
	return exposure === "codemode" || exposure === "deferred";
}

/**
 * Rank the searchable tools and activate the good matches that are not active yet, so the next model
 * call declares them. Activation is recorded in the transcript like any tool change.
 *
 * Active tools are ranked too. Otherwise a search for a tool that is already loaded would find the
 * next best tool instead and load it.
 */
function searchAndLoad(
	tools: NonNullable<ToolSearchToolOptions["tools"]>,
	query: string,
	limit: number,
): ToolSearchOutcome {
	const activeNames = tools.getActiveTools();
	const isActive = (tool: ToolInfo) => activeNames.includes(tool.name);
	const all = tools.getAllTools();
	const searchable = all.filter((tool) => isSearchable(tool.exposure));
	const documents = searchable.map((tool) => createToolSearchDocument(tool, tool.namespace));
	const matches = new Bm25Ranker().rank(query, documents, documents.length).flatMap((match) => {
		const tool = searchable.find((candidate) => candidate.name === match.name);
		return tool ? [{ tool, strong: match.strong }] : [];
	});
	const loaded: ToolInfo[] = [];
	const active: string[] = [];
	// Good matches that are already active are reported when they rank above a tool this call loads, or
	// when it loads none: the tool the model wants may be one of them.
	let passed: string[] = [];
	for (const { tool, strong } of matches) {
		if (!strong || loaded.length === limit) break;
		if (isActive(tool)) {
			passed.push(tool.name);
		} else {
			loaded.push(tool);
			active.push(...passed);
			passed = [];
		}
	}
	if (loaded.length === 0) active.push(...passed);
	// `limit` bounds what one call returns, also for names.
	active.splice(limit);
	// Names in the query that the ranking does not answer for: tools it does not search, and names that
	// nothing in the session has.
	const notOffered: string[] = [];
	const unknown: string[] = [];
	const names = nameWords(query);
	for (const tool of all) {
		if (isSearchable(tool.exposure) || !namesTool(query, names, tool.name)) continue;
		(isActive(tool) ? active : notOffered).push(tool.name);
	}
	for (const word of names) {
		const known = all.some((tool) => {
			const terms = new Set([...tokenize(tool.name), ...tokenize(tool.namespace?.name ?? "")]);
			return word.terms.every((term) => terms.has(term));
		});
		if (!known && loaded.length === 0) unknown.push(word.text);
	}
	const closest =
		loaded.length > 0 || active.length > 0
			? []
			: matches.slice(0, limit).map(({ tool }) => ({ tool, active: isActive(tool) }));
	if (loaded.length > 0) tools.setActiveTools([...activeNames, ...loaded.map((tool) => tool.name)]);
	return { loaded, closest, active: [...new Set(active)], notOffered, unknown: [...new Set(unknown)] };
}

/** The first line of a tool's description. */
function summary(tool: ToolInfo): string {
	return tool.description.trim().split(/\r?\n/)[0];
}

/**
 * The result text: first what the query named or matched that needs no loading or cannot be loaded, then the
 * loaded tools or, when there is no good match, the closest ones.
 */
function describeOutcome({ loaded, closest, active, notOffered, unknown }: ToolSearchOutcome): string {
	const lines: string[] = [];
	if (active.length > 0) {
		lines.push(
			`${active.join(", ")} ${active.length === 1 ? "is already active; call it" : "are already active; call them"} directly.`,
		);
	}
	if (notOffered.length > 0) {
		lines.push(
			`${notOffered.join(", ")} ${notOffered.length === 1 ? "is" : "are"} not available in this session; ${TOOL_SEARCH_TOOL_NAME} cannot load ${notOffered.length === 1 ? "it" : "them"}.`,
		);
	}
	if (unknown.length > 0) lines.push(`No tool or server in this session has ${unknown.join(" or ")} in its name.`);
	if (loaded.length > 0) {
		lines.push(
			`Loaded ${loaded.length} tool${loaded.length === 1 ? "" : "s"}. They are available from your next call:`,
			...loaded.map((tool) => `- ${tool.name}: ${summary(tool)}`),
		);
	} else if (closest.length > 0) {
		lines.push(
			"No tool is a close match, so none was loaded. Closest matches; search for an exact name to load one:",
			...closest.map((match) => `- ${match.tool.name}: ${match.active ? "already active" : summary(match.tool)}`),
		);
	} else if (lines.length === 0) {
		lines.push("No matching tools found.");
	}
	return lines.join("\n");
}

/**
 * The `tool_search` description. It does not list the searchable tools or their namespaces, so it
 * stays the same while tools are registered, for example when MCP servers connect.
 */
export const TOOL_SEARCH_DESCRIPTION = `# Tool discovery\n\nSearches over deferred tool metadata with BM25 and exposes matching tools for the next model call.\n\nSome of the tools, such as tools of MCP servers, may not have been provided to you upfront, and you should use this tool (\`${TOOL_SEARCH_TOOL_NAME}\`) to search for the required tools. For MCP tool discovery, always use \`${TOOL_SEARCH_TOOL_NAME}\`.`;

export function createToolSearchToolDefinition(
	options: ToolSearchToolOptions = {},
): ToolDefinition<typeof toolSearchSchema, ToolSearchToolDetails> {
	return {
		name: TOOL_SEARCH_TOOL_NAME,
		label: TOOL_SEARCH_TOOL_NAME,
		description: TOOL_SEARCH_DESCRIPTION,
		promptSnippet: "Search for tools that are not loaded yet and load the matches",
		parameters: toolSearchSchema,
		// Searching is not something scripts need; it changes what the model sees.
		exposure: "model-only",
		// A query can match any tool that is not declared yet.
		reachesTools: () => "all",
		async execute(_toolCallId, { query, limit }) {
			if (query.trim() === "") throw new Error("query must not be empty");
			const max = limit ?? DEFAULT_TOOL_SEARCH_LIMIT;
			if (!Number.isInteger(max) || max <= 0) throw new Error("limit must be a positive integer");
			if (!options.tools)
				return { content: [{ type: "text", text: "No matching tools found." }], details: { loaded: [] } };
			const outcome = searchAndLoad(options.tools, query, max);
			const unavailable = [...outcome.notOffered, ...outcome.unknown];
			return {
				content: [{ type: "text", text: describeOutcome(outcome) }],
				details: {
					loaded: outcome.loaded.map((tool) => tool.name),
					...(outcome.closest.length > 0 ? { listed: outcome.closest.map((match) => match.tool.name) } : {}),
					...(outcome.active.length > 0 ? { active: outcome.active } : {}),
					...(unavailable.length > 0 ? { unavailable } : {}),
				},
			};
		},
	};
}
