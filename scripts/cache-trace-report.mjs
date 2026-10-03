#!/usr/bin/env node
import { createReadStream, statSync } from "node:fs";
import { createInterface } from "node:readline";

const help = `Usage: node scripts/cache-trace-report.mjs <trace.jsonl> [trace.jsonl ...]

Read-only, offline report of ordinary request pairs. No provider calls, warming,
credential discovery, or investigation-key reads. Output is JSON.

Examples:
  node scripts/cache-trace-report.mjs /private/cache-study/trace-*.jsonl
  node scripts/cache-trace-report.mjs first.jsonl resumed.jsonl > report.json

Exit codes: 0 report/help; 1 unreadable input; 2 invalid arguments or trace.
-h, --help  Show this help.

Overlap estimates are not measured cache-key divergence, avoidable waste, or
subscription billing. Stable observed input is not proof of server cache identity.
`;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const hmac = (value) => typeof value === "string" ? value : value?.hmac;
const validDigest = (value) => digest.test(hmac(value) ?? "");
const numeric = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;

function divergence(previous, current) {
  for (const group of ["instructions", "tools", "input"]) {
    const old = previous.components.filter((item) => item.group === group);
    const next = current.components.filter((item) => item.group === group);
    for (let index = 0; index < old.length; index++) {
      if (old[index].hmac === next[index]?.hmac) continue;
      const blocks = old[index].blocks ?? [];
      const nextBlocks = next[index]?.blocks ?? [];
      const block = blocks.findIndex((value, i) => !equal(value, nextBlocks[i]));
      return { group, index, ...(block >= 0 ? { block } : {}), change: next[index] ? "changed" : "removed" };
    }
    // Instructions and top-level declarations are controls, not a conversational suffix.
    if (group !== "input" && old.length !== next.length) return { group, index: old.length, change: "added" };
  }
  return undefined;
}

function cachedField(records, api, parsed) {
  if (!parsed?.usageSourceAttemptId) return undefined;
  const terminals = records.slice(0, records.lastIndexOf(parsed)).filter((record) => record.kind === "terminal" && record.attemptId === parsed.usageSourceAttemptId);
  let terminal;
  let keys;
  if (api === "anthropic-messages") {
    keys = ["cache_read_input_tokens"];
    terminal = terminals.findLast((record) => record.type === "message_start" ||
      (record.type === "message_delta" && record.fields?.[keys[0]]?.present && !["null", "undefined"].includes(record.fields[keys[0]].type)));
  } else if (api === "openai-completions") {
    keys = ["prompt_tokens_details.cached_tokens", "prompt_cache_hit_tokens", "cached_tokens"];
    terminal = terminals.findLast((record) => record.type === "chat.usage" && record.usage?.present && !["null", "undefined"].includes(record.usage.type));
  } else if (api === "openai-codex-responses" || api === "openai-responses") {
    keys = ["input_tokens_details.cached_tokens"];
    terminal = api === "openai-codex-responses"
      ? terminals.find((record) => record.type?.startsWith("response."))
      : terminals.findLast((record) => record.type?.startsWith("response.") && record.usage?.present && !["null", "undefined"].includes(record.usage.type));
  } else return undefined;
  if (terminal?.usage?.type !== "object") return undefined;
  const key = keys.find((key) => terminal?.fields?.[key]?.present && !["null", "undefined"].includes(terminal.fields[key].type));
  const field = terminal?.fields?.[key];
  if (field?.type !== "number" || !numeric(field.value) || field.value !== parsed.usage?.cacheRead) return undefined;
  return { value: field.value, key, terminalType: terminal.type, responseId: terminal.responseId };
}

function summarize(records, headersByGeneration) {
  const request = records.find((record) => record.kind === "request");
  const logicals = records.filter((record) => record.kind === "logical");
  const parsed = records.findLast((record) => record.kind === "parsed_usage");
  const logical = logicals.length === 1 ? logicals[0] : undefined;
  const components = logical?.components;
  const indices = { instructions: 0, tools: 0, input: 0 };
  const complete = Array.isArray(components) && components.every((item) =>
    Object.hasOwn(indices, item.group) && item.index === indices[item.group]++ && Number.isInteger(item.bytes) && numeric(item.bytes) && validDigest(item.hmac)
  ) && validDigest(logical.fullBody) && validDigest(logical.controls) && !records.some((record) => record.kind === "coverage_gap" && record.incomplete !== false);
  const cached = cachedField(records, request?.api, parsed);
  const source = parsed?.usageSourceAttemptId;
  const attemptRecords = records.filter((record) => record.attemptId === source);
  const generation = attemptRecords.findLast((record) => record.kind === "send")?.generation;
  const headers = attemptRecords.findLast((record) => record.kind === "policy_headers")?.headers ?? headersByGeneration.get(generation);
  const policyHeaders = headers && Object.fromEntries(Object.entries(headers).filter(([key]) => key !== "x-client-request-id"));
  const returned = Object.assign({}, ...attemptRecords.filter((record) => record.kind === "terminal").map((record) => record.returned ?? {}));
  const usage = parsed?.usage;
  const prompt = usage && [usage.input, usage.cacheRead, usage.cacheWrite].every(numeric) ? usage.input + usage.cacheRead + usage.cacheWrite : undefined;
  return { request, logical, complete, cached, prompt, parsed, records, policyHeaders, returned };
}

function classify(previous, current) {
  const a = previous.request;
  const b = current.request;
  const firstDivergence = previous.complete && current.complete ? divergence(previous.logical, current.logical) : undefined;
  const common = {
    previousRequestId: a.logicalRequestId,
    requestId: b.logicalRequestId,
    purpose: b.purpose,
    previousPromptTokens: previous.prompt,
    promptTokens: current.prompt,
    overlapEstimate: numeric(previous.prompt) && numeric(current.prompt) && current.cached ? Math.max(0, Math.min(previous.prompt, current.prompt) - current.cached.value) : undefined,
    cached: current.cached ?? { presence: "unknown" },
    firstDivergence,
    coverageGaps: [...(a.coverageGaps ?? []), ...(b.coverageGaps ?? [])],
    usageSourceAttemptId: current.parsed?.usageSourceAttemptId,
    policyHeadersComplete: previous.policyHeaders !== undefined && current.policyHeaders !== undefined,
  };
  const result = (classification, reason, extra = {}) => ({ ...common, classification, reason, ...extra });
  if (!previous.complete || !current.complete) return result("unknown", "Logical or send/usage capture incomplete; no stable-prefix verdict.");
  if (!previous.cached || previous.parsed?.consumedUsage !== true || !current.cached || !current.parsed?.usageSourceAttemptId || current.parsed.consumedUsage !== true) return result("unknown_reporting", "Cached usage detail or current consumed-attempt provenance is missing or inherited from an earlier attempt, not an explicit current zero.");
  if (!current.records.some((record) => record.kind === "wire" && record.attemptId === current.parsed.usageSourceAttemptId) || !previous.records.some((record) => record.kind === "wire" && record.attemptId === previous.parsed?.usageSourceAttemptId)) {
    return result("unknown", "Actual envelope for consumed usage is unavailable.");
  }
  const boundaries = [];
  for (const key of ["physicalModel", "api", "compat", "account"]) if (!equal(a[key], b[key])) boundaries.push(key);
  for (const key of ["windowId", "runtimeGeneration", "reloadGeneration", "catalogDigest", "extensionsDigest", "configGeneration", "authGeneration", "selectedProvider", "selectedModel"]) {
    if (!equal(a.provenance?.[key], b.provenance?.[key])) boundaries.push(key);
  }
  for (const key of ["model", "service_tier", "reasoning", "reasoning_effort", "thinking", "output_config", "prompt_cache_retention", "tier", "verbosity", "effort", "thinkingBudget", "retention", "cacheMode", "cacheTtl"]) {
    if (!equal(previous.logical.requested?.[key], current.logical.requested?.[key])) boundaries.push(key);
  }
  for (const key of ["model", "service_tier", "tier"]) if (!equal(previous.returned[key], current.returned[key])) boundaries.push(`returned.${key}`);
  if (boundaries.length) return result("expected_boundary", "Observed model, policy, identity, reset or runtime boundary; exclude from unexplained regressions.", { boundaries });
  if (firstDivergence) return result("earlier_input_changed", "Previously submitted semantic input or top-level declarations changed; ownership and necessity need inspection.");
  if (!equal(previous.logical.controls, current.logical.controls) || !equal(previous.logical.cacheMarkers, current.logical.cacheMarkers) || !equal(previous.logical.cacheKey, current.logical.cacheKey) || (common.policyHeadersComplete && !equal(previous.policyHeaders, current.policyHeaders))) {
    return result("observed_controls_changed", "Input prefix is unchanged, but request controls or cache markers changed.");
  }
  const route = (value) => ({
    endpoint: value.request.endpoint,
    attempts: value.records.filter((record) => record.kind === "attempt").map((record) => record.transport),
    events: value.records.filter((record) => ["transport", "acquisition", "handshake", "continuation", "retry", "fallback", "send", "http_response"].includes(record.kind)).map((record) => ({
      kind: record.kind, endpoint: record.endpoint, transport: record.transport, configuredTransport: record.configuredTransport,
      generation: record.generation, reused: record.reused, full: record.full, stickySse: record.stickySse,
      reason: record.reason, state: record.state, redirected: record.redirected, status: record.status,
    })),
  });
  if (!equal(route(previous), route(current))) return result("prefix_stable_route_changed", "Observed input prefix is stable and attempt/route metadata changed; correlation is not a cache-loss cause or complete-control verdict.");
  const unknownControls = common.coverageGaps.filter((gap) => !["server_cache_identity_unobserved", "fetch_redirect_hops_unobserved", "proxy_route_unobserved"].includes(gap));
  if (unknownControls.length || !common.policyHeadersComplete) return result("unknown_controls", "Observed input is stable; provenance or identity coverage is incomplete, so client/provider causes remain unresolved.");
  if (current.cached.value === 0) return result("unresolved_provider_candidate", "Observed input and controls stable with explicit zero; server diagnostics needed, not an eviction verdict.");
  return result("observed_prefix_stable", "Observed input/controls are stable; new suffixes require processing and cache accounting remains provider-specific.");
}

async function main() {
  const files = process.argv.slice(2);
  if (files.length === 1 && ["-h", "--help"].includes(files[0])) { console.log(help); return; }
  if (!files.length || files.length > 64 || files.some((file) => file.startsWith("-"))) {
    console.error(help); process.exitCode = 2; return;
  }
  const requests = new Map();
  const processGaps = new Map();
  let ordinal = 0;
  for (const file of files) {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw Object.assign(new Error("Trace must be a regular file no larger than 16 MiB."), { invalid: true });
    let lineNumber = 0;
    for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
      lineNumber++;
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { throw Object.assign(new Error(`Invalid JSON at input ${files.indexOf(file) + 1}, line ${lineNumber}.`), { invalid: true }); }
      const processGap = record?.kind === "coverage_gap" && record.logicalRequestId === undefined;
      if (Buffer.byteLength(line) > 256 * 1024 || record?.v !== 1 || (!processGap && !uuid.test(record.logicalRequestId ?? "")) || !uuid.test(record.processGeneration ?? "") || !numeric(record.at) || typeof record.kind !== "string") {
        throw Object.assign(new Error(`Invalid trace at input ${files.indexOf(file) + 1}, line ${lineNumber}.`), { invalid: true });
      }
      if (processGap) {
        if (!processGaps.has(record.processGeneration)) processGaps.set(record.processGeneration, []);
        processGaps.get(record.processGeneration).push(record);
        continue;
      }
      const key = `${record.processGeneration}:${record.logicalRequestId}`;
      if (!requests.has(key)) requests.set(key, { ordinal: ordinal++, records: [] });
      requests.get(key).records.push(record);
    }
  }
  const headersByGeneration = new Map();
  for (const { records } of requests.values()) {
    let handshake;
    for (const record of records) {
      if (record.kind === "attempt") handshake = undefined;
      if (record.kind === "handshake") handshake = record;
      if (handshake && record.kind === "policy_headers" && record.attemptId === handshake.attemptId) {
        if (!headersByGeneration.has(handshake.generation)) headersByGeneration.set(handshake.generation, record.headers);
        handshake = undefined;
      }
    }
  }
  const ordered = [...requests.values()].map(({ ordinal, records }) => ({ ordinal, ...summarize([...records, ...(processGaps.get(records[0].processGeneration) ?? [])], headersByGeneration) })).filter((value) => value.request).sort((a, b) => a.request.at - b.request.at || a.ordinal - b.ordinal);
  const baselines = new Map();
  const pairs = [];
  let unpaired = 0;
  for (const current of ordered) {
    const session = current.request.provenance?.sessionId;
    if (!validDigest(session)) { unpaired++; continue; }
    const family = `${hmac(session)}:${current.request.purpose}`;
    const previous = baselines.get(family);
    if (previous) pairs.push(classify(previous, current)); else unpaired++;
    baselines.set(family, current);
  }
  console.log(JSON.stringify({ version: 1, requests: ordered.length, unpaired, pairs, caveat: "Metadata-only prospective evidence; overlap estimates are not avoidable waste or invoices. No server-side cache identity or eviction inference." }, null, 2));
}
main().catch((error) => { console.error(error.invalid ? error.message : "Unable to read supplied trace input."); process.exitCode = error.invalid ? 2 : 1; });
