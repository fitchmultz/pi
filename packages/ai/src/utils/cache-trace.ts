import type * as Crypto from "node:crypto";
import type * as Fs from "node:fs";
import type * as Path from "node:path";
import type { Api, Model, ProviderRequestOptions, Usage } from "../types.ts";

// ponytail: temporary Node-only passive investigation, not general telemetry. Remove this
// recorder and its private directory when finished. Unknown coverage cannot prove stability.
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_RECORD_BYTES = 256 * 1024;
const MAX_COMPONENTS = 2048;
const MAX_FILES = 64;
const LIFETIME_MS = 24 * 60 * 60 * 1000;
const GAP_RESERVE_BYTES = 1024;
const PROVENANCE_FIELDS = [
	"sessionId",
	"branchId",
	"windowId",
	"runtimeGeneration",
	"reloadGeneration",
	"selectedProvider",
	"selectedModel",
	"release",
	"catalogDigest",
	"extensionsDigest",
	"configGeneration",
	"authGeneration",
] as const;
const KNOWN_GAPS = new Set([
	"extension_entry_disk_snapshot",
	"sdk_provenance_unavailable",
	"custom_fetch_transport_unobserved",
	"auth_generation_unknown",
	"effective_identity_unknown",
	"runtime_provenance_unknown",
	"config_generation_unknown",
	"external_config_generation_unknown",
	"loaded_module_graph_unverified",
	"loaded_dependency_graph_unverified",
	"extension_route_uninstrumented",
	"custom_provider_uninstrumented",
	"unsupported_api",
	"nested_call_provenance_unknown",
	"server_cache_identity_unobserved",
	"fetch_redirect_hops_unobserved",
	"proxy_route_unobserved",
	"logical_capture_incomplete",
	"wire_capture_incomplete",
	"terminal_capture_incomplete",
	"metadata_capture_incomplete",
	"http_body_unobserved",
	"retry_logical_body_changed",
	"http_headers_unobserved",
	"injected_client_wire_unobserved",
	"handshake_generation_unobserved",
	"observer_failure",
	"file_limit",
	"record_limit",
	"lifetime_limit",
]);
const SAFE_VALUES = new Set([
	"none",
	"short",
	"long",
	"24h",
	"30m",
	"1h",
	"ephemeral",
	"explicit",
	"auto",
	"default",
	"flex",
	"priority",
	"fast",
	"ultrafast",
	"low",
	"minimal",
	"medium",
	"high",
	"xhigh",
	"max",
	"enabled",
	"disabled",
	"adaptive",
	"summarized",
	"omitted",
	"off",
	"on",
	"concise",
	"detailed",
	"sse",
	"websocket",
	"websocket-cached",
	"zstd",
	"no_session",
	"no_connection",
	"busy",
	"dead",
	"aged",
	"reused",
	"no_baseline",
	"non_input_mismatch",
	"input_shorter",
	"input_mismatch",
	"eligible",
	"transport_not_cached",
	"previous_response_not_found",
	"websocket_connection_limit_reached",
	"transport_failure",
	"http_status",
	"http_error",
	"completed",
	"incomplete",
	"failed",
	"cancelled",
	"queued",
	"in_progress",
	"stop",
	"length",
	"toolUse",
	"error",
	"aborted",
	"pending",
]);
const EVENT_KINDS = new Set([
	"transport",
	"acquisition",
	"handshake",
	"continuation",
	"retry",
	"fallback",
	"send",
	"attempt_error",
	"connection_release",
	"outcome",
]);
const BOOLEAN_METADATA = new Set(["reused", "busy", "full", "stickySse", "started", "keep"]);
const NUMBER_METADATA = new Set([
	"status",
	"ageMs",
	"index",
	"closeCode",
	"delayMs",
	"inputItems",
	"logicalInputItems",
]);
const SAFE_HEADERS = [
	"anthropic-beta",
	"openai-beta",
	"originator",
	"user-agent",
	"session-id",
	"session_id",
	"x-session-id",
	"x-session-affinity",
	"x-client-request-id",
	"content-encoding",
];

type TraceModel = Pick<Model<Api>, "id" | "api" | "provider" | "baseUrl" | "compat">;
type TraceOptions = Pick<ProviderRequestOptions, "cacheTraceContext" | "fetch">;
type Metadata = Record<string, unknown>;
type Fingerprint = { hmac: string; bytes: number };
type FileIdentity = Pick<Fs.Stats, "dev" | "ino">;
type Writer = {
	fs: typeof Fs;
	crypto: typeof Crypto;
	key: Uint8Array;
	directory: string;
	directoryIdentity: FileIdentity;
	keyPath: string;
	keyIdentity: FileIdentity;
	file: string;
	fileIdentity: FileIdentity;
	processGeneration: string;
	expiresAt: number;
	bytes: number;
	stopped: boolean;
};
let writer: Writer | undefined;
let failedDirectory: string | undefined;

function warnUnavailable(): void {
	try {
		console.warn("PI_CACHE_TRACE_DIR coverage gap: private recorder unavailable; requests are unchanged.");
	} catch {}
}

function privateStat(stat: Fs.Stats, directory = false): void {
	if (
		(directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
		(stat.mode & 0o777) !== (directory ? 0o700 : 0o600) ||
		(typeof process.getuid === "function" && stat.uid !== process.getuid())
	) {
		throw new Error("Unsafe cache trace file");
	}
}

function openPrivate(fs: typeof Fs, path: string, flags: number): number {
	const fd = fs.openSync(path, flags | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
	try {
		const stat = fs.fstatSync(fd);
		privateStat(stat);
		const named = fs.lstatSync(path);
		if (named.dev !== stat.dev || named.ino !== stat.ino || named.isSymbolicLink())
			throw new Error("Cache trace file changed");
		return fd;
	} catch (error) {
		fs.closeSync(fd);
		throw error;
	}
}

function admittedStat(stat: Fs.Stats, identity: FileIdentity, directory = false): void {
	privateStat(stat, directory);
	if (stat.dev !== identity.dev || stat.ino !== identity.ino) throw new Error("Cache trace path replaced");
}

function validateWriter(w: Writer): void {
	admittedStat(w.fs.lstatSync(w.directory), w.directoryIdentity, true);
	const key = w.fs.lstatSync(w.keyPath);
	admittedStat(key, w.keyIdentity);
	if (key.size !== 32) throw new Error("Investigation key changed");
	const file = w.fs.lstatSync(w.file);
	admittedStat(file, w.fileIdentity);
	if (file.size !== w.bytes) throw new Error("Trace file changed");
}

function getWriter(): Writer | undefined {
	if (typeof process === "undefined" || !process.env?.PI_CACHE_TRACE_DIR) return undefined;
	const directory = process.env.PI_CACHE_TRACE_DIR;
	if (writer?.directory === directory) {
		if (writer.stopped) return undefined;
		try {
			validateWriter(writer);
		} catch {
			writer.stopped = true;
			warnUnavailable();
			return undefined;
		}
		if (!writer.stopped && Date.now() >= writer.expiresAt)
			append(writer, { kind: "coverage_gap", reason: "lifetime_limit", incomplete: true });
		return writer.stopped ? undefined : writer;
	}
	if (failedDirectory === directory) return undefined;
	try {
		const getBuiltinModule = process.getBuiltinModule;
		if (!getBuiltinModule) throw new Error("Node builtins unavailable");
		const fs = getBuiltinModule("node:fs") as typeof Fs;
		const crypto = getBuiltinModule("node:crypto") as typeof Crypto;
		const path = getBuiltinModule("node:path") as typeof Path;
		fs.mkdirSync(directory, { mode: 0o700, recursive: true });
		const directoryIdentity = fs.lstatSync(directory);
		privateStat(directoryIdentity, true);
		const canonical = fs.realpathSync(directory);
		const keyPath = path.join(canonical, "investigation.key");
		if (!fs.existsSync(keyPath)) {
			const temporary = path.join(canonical, `.key-${crypto.randomUUID()}`);
			try {
				const fd = openPrivate(fs, temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL);
				try {
					fs.writeFileSync(fd, crypto.randomBytes(32));
				} finally {
					fs.closeSync(fd);
				}
				// Atomically publish a complete key without overwriting another process's key.
				try {
					fs.linkSync(temporary, keyPath);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				}
			} finally {
				fs.rmSync(temporary, { force: true });
			}
		}
		const keyFd = openPrivate(fs, keyPath, fs.constants.O_RDONLY);
		let key: Uint8Array;
		let expiresAt: number;
		let keyIdentity: FileIdentity;
		try {
			const stat = fs.fstatSync(keyFd);
			keyIdentity = stat;
			if (stat.size !== 32) throw new Error("Invalid investigation key");
			expiresAt = stat.mtimeMs + LIFETIME_MS;
			if (Date.now() >= expiresAt) throw new Error("Investigation expired");
			key = fs.readFileSync(keyFd);
		} finally {
			fs.closeSync(keyFd);
		}
		let file: string | undefined;
		let fileIdentity: FileIdentity | undefined;
		for (let slot = 0; slot < MAX_FILES; slot++) {
			const candidate = path.join(canonical, `trace-${slot}.jsonl`);
			try {
				const fd = openPrivate(fs, candidate, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL);
				try {
					fileIdentity = fs.fstatSync(fd);
				} finally {
					fs.closeSync(fd);
				}
				file = candidate;
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
		}
		if (!file || !fileIdentity) throw new Error("Investigation file limit");
		const admitted = {
			fs,
			crypto,
			key,
			directory,
			directoryIdentity,
			keyPath,
			keyIdentity,
			file,
			fileIdentity,
			processGeneration: crypto.randomUUID(),
			expiresAt,
			bytes: 0,
			stopped: false,
		};
		validateWriter(admitted);
		writer = admitted;
		return writer;
	} catch {
		failedDirectory = directory;
		warnUnavailable();
		return undefined;
	}
}

function fingerprint(w: Writer, value: unknown): Fingerprint {
	const bytes =
		value instanceof Uint8Array
			? value
			: new TextEncoder().encode(typeof value === "string" ? value : (JSON.stringify(value) ?? "undefined"));
	return { hmac: w.crypto.createHmac("sha256", w.key).update(bytes).digest("hex"), bytes: bytes.byteLength };
}

/** HMAC source/provenance bytes only when explicitly enabled; never retains the source. */
export function cacheTraceDigest(value: unknown): string | undefined {
	try {
		const w = getWriter();
		return w ? fingerprint(w, value).hmac : undefined;
	} catch {
		return undefined;
	}
}

function append(w: Writer, record: Metadata): void {
	if (w.stopped) return;
	try {
		validateWriter(w);
		let line = `${JSON.stringify({ v: 1, processGeneration: w.processGeneration, at: Date.now(), ...record })}\n`;
		const bytes = new TextEncoder().encode(line).byteLength;
		if (
			Date.now() >= w.expiresAt ||
			bytes > MAX_RECORD_BYTES ||
			w.bytes + bytes > MAX_FILE_BYTES - GAP_RESERVE_BYTES
		) {
			line = `${JSON.stringify({ v: 1, processGeneration: w.processGeneration, at: Date.now(), logicalRequestId: record.logicalRequestId, attemptId: record.attemptId, kind: "coverage_gap", reason: Date.now() >= w.expiresAt ? "lifetime_limit" : bytes > MAX_RECORD_BYTES ? "record_limit" : "file_limit", incomplete: true })}\n`;
			w.stopped = true;
		}
		const fd = openPrivate(w.fs, w.file, w.fs.constants.O_WRONLY | w.fs.constants.O_APPEND);
		try {
			const stat = w.fs.fstatSync(fd);
			admittedStat(stat, w.fileIdentity);
			if (stat.size !== w.bytes) throw new Error("Trace file changed");
			w.fs.writeFileSync(fd, line);
			w.bytes += new TextEncoder().encode(line).byteLength;
		} finally {
			w.fs.closeSync(fd);
		}
	} catch {
		w.stopped = true;
		warnUnavailable();
	}
}

function object(value: unknown): Metadata {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Metadata) : {};
}

function field(value: Metadata, key: string): Metadata {
	const v = value[key];
	return {
		present: Object.hasOwn(value, key),
		type: v === null ? "null" : Array.isArray(v) ? "array" : typeof v,
		...(typeof v === "number" && Number.isFinite(v) ? { value: v } : {}),
	};
}

function safeId(value: unknown): string | undefined {
	return typeof value === "string" &&
		(/^(resp_|msg_|req_|chatcmpl_)[a-zA-Z0-9_-]{1,120}$/.test(value) ||
			/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value))
		? value
		: undefined;
}

function endpoint(value: string): string | undefined {
	try {
		const url = new URL(value);
		return ["https:", "http:", "wss:", "ws:"].includes(url.protocol) ? `${url.protocol}//${url.host}` : undefined;
	} catch {
		return undefined;
	}
}

// Only protocol cache markers are removed, never schema properties or tool arguments.
function semantic(value: unknown, markers: Metadata[], path = "", depth = 0): unknown {
	if (depth > 64) throw new Error("Trace depth limit");
	if (Array.isArray(value)) return value.map((item, i) => semantic(item, markers, `${path}/${i}`, depth + 1));
	if (!value || typeof value !== "object") return value;
	const result: Metadata = {};
	for (const [key, item] of Object.entries(value)) {
		if (key === "cache_control") markers.push({ path, value: item });
		else if (["parameters", "input_schema", "arguments"].includes(key) || (key === "input" && depth > 0))
			result[key] = item;
		else result[key] = semantic(item, markers, `${path}/${key}`, depth + 1);
	}
	return result;
}

export class CacheTrace {
	private readonly writer: Writer;
	readonly logicalRequestId: string;
	private attemptId?: string;
	private usageSourceAttemptId?: string;
	private sdkLogicalBody?: Fingerprint;
	private sequence = 0;

	constructor(w: Writer, model: TraceModel, options?: TraceOptions, accountId?: string, resolvedCompat?: unknown) {
		this.writer = w;
		this.logicalRequestId = w.crypto.randomUUID();
		const context = options?.cacheTraceContext ?? {};
		const provenance: Metadata = {};
		for (const key of PROVENANCE_FIELDS) {
			const value = context[key];
			if (value === undefined) continue;
			provenance[key] =
				typeof value === "number" && Number.isFinite(value)
					? value
					: /Digest$/.test(key) && /^[a-f0-9]{64}$/.test(String(value))
						? value
						: fingerprint(w, value);
		}
		const extensions = context.extensions?.slice(0, MAX_COMPONENTS).map((extension) => ({
			path: fingerprint(w, extension.path),
			digest: /^[a-f0-9]{64}$/.test(extension.digest ?? "") ? extension.digest : undefined,
			loaded: extension.loaded === true,
		}));
		this.write("request", {
			api: ["openai-responses", "openai-completions", "anthropic-messages", "openai-codex-responses"].includes(
				model.api,
			)
				? model.api
				: fingerprint(w, model.api),
			physicalModel: fingerprint(w, [model.provider, model.id]),
			compat: fingerprint(w, resolvedCompat ?? model.compat),
			endpoint: endpoint(model.baseUrl),
			purpose: ["parent", "child", "warming", "summary", "nested"].includes(context.purpose ?? "")
				? context.purpose
				: "unknown",
			provenance,
			extensions,
			account: accountId ? fingerprint(w, accountId) : undefined,
			coverageGaps: [
				...new Set([
					...(context.coverageGaps ?? [])
						.slice(0, 64)
						.map((gap) => (KNOWN_GAPS.has(gap) ? gap : "unrecognized_provenance_gap")),
					...(context.authGeneration === undefined ? ["auth_generation_unknown"] : []),
					...(!accountId ? ["effective_identity_unknown"] : []),
					...(!context.runtimeGeneration ? ["runtime_provenance_unknown"] : []),
					...(!context.configGeneration ? ["config_generation_unknown"] : []),
					...(options?.fetch ? ["custom_fetch_transport_unobserved"] : []),
					"server_cache_identity_unobserved",
					"fetch_redirect_hops_unobserved",
					"proxy_route_unobserved",
				]),
			],
		});
		if ((context.extensions?.length ?? 0) > MAX_COMPONENTS || (context.coverageGaps?.length ?? 0) > 64)
			this.gap("metadata_capture_incomplete");
	}

	private write(kind: string, metadata: Metadata): void {
		append(this.writer, { logicalRequestId: this.logicalRequestId, attemptId: this.attemptId, kind, ...metadata });
	}

	private observe(action: () => void): void {
		if (this.writer.stopped) return;
		try {
			validateWriter(this.writer);
			if (Date.now() >= this.writer.expiresAt) {
				this.gap("lifetime_limit");
				return;
			}
			action();
		} catch {
			this.gap("observer_failure");
		}
	}

	gap(reason: string): void {
		try {
			this.write("coverage_gap", {
				reason: KNOWN_GAPS.has(reason) ? reason : "unspecified_capture_gap",
				incomplete: true,
			});
		} catch {}
	}

	/** Native scalar metadata only. Unknown/nested fields are rejected, never serialized. */
	event(kind: string, metadata: Metadata = {}): void {
		this.observe(() => {
			if (!EVENT_KINDS.has(kind)) throw new Error("Unknown event");
			const safe: Metadata = {};
			for (const [key, value] of Object.entries(metadata)) {
				if (value === undefined) continue;
				if (BOOLEAN_METADATA.has(key) && typeof value === "boolean") safe[key] = value;
				else if (NUMBER_METADATA.has(key) && typeof value === "number" && Number.isFinite(value)) safe[key] = value;
				else if (key === "endpoint" && typeof value === "string") safe[key] = endpoint(value);
				else if (key === "generation" && typeof value === "string") safe[key] = safeId(value);
				else if (
					["reason", "state", "transport", "configuredTransport", "compression"].includes(key) &&
					typeof value === "string" &&
					SAFE_VALUES.has(value)
				)
					safe[key] = value;
				else {
					this.gap("metadata_capture_incomplete");
					return;
				}
			}
			this.write(kind, safe);
		});
	}

	logical(payload: unknown): void {
		this.observe(() => {
			const w = this.writer;
			const serialized = typeof payload === "string" ? payload : JSON.stringify(payload);
			const body = object(JSON.parse(serialized));
			const markers: Metadata[] = [];
			const components: Metadata[] = [];
			let blockCount = 0;
			const blocks = (items: unknown[], depth = 0): Metadata[] => {
				if (depth > 64) throw new Error("Block depth limit");
				let prefix = "";
				return items.map((block, index) => {
					if (++blockCount > MAX_COMPONENTS) throw new Error("Block limit");
					const digest = fingerprint(w, block);
					prefix = fingerprint(w, [prefix, digest.bytes, digest.hmac]).hmac;
					const item = object(block);
					return {
						index,
						...digest,
						prefix,
						image: ["input_image", "image_url", "image"].includes(String(item.type)),
						...(Array.isArray(item.content) ? { children: blocks(item.content, depth + 1) } : {}),
					};
				});
			};
			const addGroup = (group: string, values: unknown[]): void => {
				let prefix = "";
				for (const [index, value] of values.entries()) {
					if (components.length >= MAX_COMPONENTS) throw new Error("Component limit");
					const clean = semantic(value, markers, `${group}/${index}`);
					const digest = fingerprint(w, clean);
					prefix = fingerprint(w, [prefix, digest.bytes, digest.hmac]).hmac;
					const item = object(clean);
					const content = Array.isArray(item.content)
						? item.content
						: Array.isArray(item.output)
							? item.output
							: [];
					components.push({ group, index, ...digest, prefix, blocks: blocks(content) });
				}
			};
			const input = body.input ?? body.messages;
			const inputs = Array.isArray(input) ? input : input === undefined ? [] : [input];
			const instructions = body.instructions ?? body.system;
			const leadingInstructions: unknown[] = [];
			if (instructions === undefined) {
				for (const item of inputs) {
					if (!["system", "developer"].includes(String(object(item).role))) break;
					leadingInstructions.push(item);
				}
			}
			addGroup(
				"instructions",
				Array.isArray(instructions)
					? instructions
					: instructions === undefined
						? leadingInstructions
						: [instructions],
			);
			addGroup("tools", Array.isArray(body.tools) ? body.tools : []);
			addGroup("input", inputs);
			const {
				instructions: _instructions,
				system: _system,
				tools: _tools,
				input: _input,
				messages: _messages,
				...controls
			} = body;
			this.write("logical", {
				fullBody: fingerprint(w, serialized),
				components,
				controls: fingerprint(w, controls),
				cacheMarkers: markers.map((marker) => ({
					path: fingerprint(w, marker.path),
					...fingerprint(w, marker.value),
				})),
				cacheKey: { present: Object.hasOwn(body, "prompt_cache_key"), ...fingerprint(w, body.prompt_cache_key) },
				requested: this.policy(body),
			});
		});
	}

	private policy(body: Metadata): Metadata {
		const result: Metadata = {};
		for (const key of [
			"model",
			"service_tier",
			"text",
			"reasoning",
			"reasoning_effort",
			"thinking",
			"output_config",
			"prompt_cache_retention",
			"prompt_cache_options",
			"stream",
			"store",
			"max_tokens",
			"max_output_tokens",
			"max_completion_tokens",
			"cache_diagnostics",
		]) {
			if (Object.hasOwn(body, key)) result[key] = fingerprint(this.writer, body[key]);
		}
		const scalars = {
			tier: body.service_tier,
			verbosity: object(body.text).verbosity,
			effort: object(body.reasoning).effort ?? body.reasoning_effort ?? object(body.output_config).effort,
			thinking: object(body.thinking).type,
			thinkingBudget: object(body.thinking).budget_tokens,
			retention: body.prompt_cache_retention,
			cacheMode: object(body.prompt_cache_options).mode,
			cacheTtl: object(body.prompt_cache_options).ttl,
		};
		for (const [key, value] of Object.entries(scalars)) {
			if (
				(typeof value === "string" && SAFE_VALUES.has(value)) ||
				(typeof value === "number" && Number.isFinite(value))
			)
				result[key] = value;
		}
		return result;
	}

	attempt(transport: "sse" | "websocket"): string | undefined {
		this.observe(() => {
			this.attemptId = this.writer.crypto.randomUUID();
			this.sequence = 0;
			this.write("attempt", { transport });
		});
		return this.attemptId;
	}

	connectionGeneration(): string | undefined {
		let generation: string | undefined;
		this.observe(() => {
			generation = this.writer.crypto.randomUUID();
		});
		return generation;
	}

	wire(body: unknown, metadata: Metadata = {}): void {
		this.observe(() => {
			this.write("wire", { envelope: fingerprint(this.writer, body) });
			this.event("send", metadata);
		});
	}

	headers(headers: Headers | undefined): void {
		this.observe(() => {
			if (!(headers instanceof Headers)) {
				this.gap("http_headers_unobserved");
				return;
			}
			const safe: Metadata = {};
			for (const key of SAFE_HEADERS) {
				const value = headers.get(key);
				if (value !== null) safe[key] = fingerprint(this.writer, value);
			}
			this.write("policy_headers", { headers: safe });
		});
	}

	response(response: Response): void {
		this.observe(() =>
			this.write("http_response", {
				status: response.status,
				redirected: response.redirected,
				endpoint: endpoint(response.url),
				requestId: safeId(response.headers.get("x-request-id")),
			}),
		);
	}

	terminal(event: unknown): void {
		this.observe(() => {
			const root = object(event);
			const sequence = ++this.sequence;
			const choices = Array.isArray(root.choices) ? root.choices : [];
			const choice = object(choices[0]);
			const type = root.type ?? (root.usage || choice.usage || choice.finish_reason ? "chat.usage" : undefined);
			if (
				![
					"response.completed",
					"response.done",
					"response.incomplete",
					"response.failed",
					"message_start",
					"message_delta",
					"message_stop",
					"chat.usage",
				].includes(String(type))
			)
				return;
			const response = object(root.response ?? root.message ?? root);
			const usageOwner = type === "chat.usage" && !root.usage && choice.usage ? choice : response;
			const usage = object(usageOwner.usage);
			const detailsKey = Object.hasOwn(usage, "prompt_tokens_details")
				? "prompt_tokens_details"
				: "input_tokens_details";
			const details = object(usage[detailsKey]);
			const fields: Metadata = {};
			for (const key of [
				"input_tokens",
				"output_tokens",
				"total_tokens",
				"prompt_tokens",
				"completion_tokens",
				"cached_tokens",
				"prompt_cache_hit_tokens",
				"cache_read_input_tokens",
				"cache_creation_input_tokens",
			])
				fields[key] = field(usage, key);
			for (const key of ["cached_tokens", "cache_write_tokens"])
				fields[`${detailsKey}.${key}`] = field(details, key);
			this.write("terminal", {
				type,
				sequence,
				providerSequence: typeof root.sequence_number === "number" ? root.sequence_number : undefined,
				responseId: safeId(response.id),
				usage: field(usageOwner, "usage"),
				details: field(usage, detailsKey),
				fields,
				returned: this.policy(response),
				status: fingerprint(this.writer, response.status ?? object(root.delta).stop_reason ?? choice.finish_reason),
			});
		});
	}

	parsed(usage: Usage, consumedUsage = true): void {
		this.observe(() => {
			if (consumedUsage) this.usageSourceAttemptId = this.attemptId;
			const safe: Metadata = {};
			for (const key of [
				"input",
				"output",
				"cacheRead",
				"cacheWrite",
				"cacheWrite1h",
				"reasoning",
				"totalTokens",
			] as const) {
				const value = usage[key];
				if (typeof value === "number" && Number.isFinite(value)) safe[key] = value;
			}
			this.write("parsed_usage", { usage: safe, usageSourceAttemptId: this.usageSourceAttemptId, consumedUsage });
		});
	}

	wrapFetch(fetch?: typeof globalThis.fetch): typeof globalThis.fetch {
		return async (input, init) => {
			// Never inspect token exchanges made by an SDK credential chain.
			let providerRequest = false;
			try {
				providerRequest = /\/(responses|completions|messages)$/.test(new URL(String(input)).pathname);
			} catch {}
			if (!providerRequest) return (fetch ?? globalThis.fetch)(input, init);
			this.attempt("sse");
			this.observe(() => {
				if (typeof init?.body === "string" || init?.body instanceof Uint8Array) {
					const digest = fingerprint(this.writer, init.body);
					if (!this.sdkLogicalBody) {
						this.sdkLogicalBody = digest;
						if (typeof init.body === "string") this.logical(init.body);
						else this.gap("logical_capture_incomplete");
					} else if (this.sdkLogicalBody.hmac !== digest.hmac) this.gap("retry_logical_body_changed");
					this.wire(init.body, { endpoint: String(input), full: true });
				} else this.gap("http_body_unobserved");
				this.headers(init?.headers instanceof Headers ? init.headers : undefined);
			});
			try {
				const response = await (fetch ?? globalThis.fetch)(input, init);
				this.response(response);
				return response;
			} catch (error) {
				this.event("attempt_error");
				throw error;
			}
		};
	}
}

export function createCacheTrace(
	model: TraceModel,
	options?: TraceOptions,
	resolvedAccountId?: string,
	resolvedCompat?: () => unknown,
): CacheTrace | undefined {
	let w: Writer | undefined;
	try {
		w = getWriter();
		return w ? new CacheTrace(w, model, options, resolvedAccountId, resolvedCompat?.()) : undefined;
	} catch {
		if (w) append(w, { kind: "coverage_gap", reason: "observer_failure", incomplete: true });
		return undefined;
	}
}
