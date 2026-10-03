import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createCacheTrace } from "../packages/ai/src/utils/cache-trace.ts";

const cli = fileURLToPath(new URL("./cache-trace-report.mjs", import.meta.url));
const fp = (digit) => ({ hmac: digit.repeat(64), bytes: 12 });
const processGeneration = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
function request(index, { input = "d", cached = 0, purpose = "parent", gaps = [], generation = "a", transport = "sse", usageSource = true, raw = true, captureGap = false } = {}) {
  const logicalRequestId = `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`;
  const attemptId = `11111111-1111-1111-1111-${String(index).padStart(12, "0")}`;
  const record = (kind, values = {}) => ({ v: 1, at: index, processGeneration, logicalRequestId, kind, ...values });
  const components = ["instructions", "tools", "input"].map((group, i) => ({ group, index: 0, ...fp(i === 2 ? input : "c"), blocks: [] }));
  return [
    record("request", { api: "openai-codex-responses", purpose, physicalModel: fp("b"), compat: fp("c"), endpoint: "https://example.invalid", provenance: { sessionId: fp("e"), runtimeGeneration: fp(generation) }, coverageGaps: gaps }),
    record("logical", { fullBody: fp(String(index)), components, controls: fp("f"), cacheKey: { present: true, ...fp("e") }, cacheMarkers: [] }),
    record("attempt", { attemptId, transport }),
    record("wire", { attemptId, envelope: fp("f") }),
    record("policy_headers", { attemptId, headers: {} }),
    record("terminal", { attemptId, type: "response.completed", usage: { present: true, type: "object" }, fields: { "input_tokens_details.cached_tokens": raw ? { present: true, type: "number", value: cached } : { present: false, type: "undefined" } } }),
    record("parsed_usage", { attemptId, consumedUsage: usageSource, usageSourceAttemptId: attemptId, usage: { input: 4000 - cached, output: 1, cacheRead: cached, cacheWrite: 0, totalTokens: 4001 } }),
    ...(captureGap ? [record("coverage_gap", { reason: "record_limit", incomplete: true })] : []),
  ];
}
function report(records) {
  const dir = mkdtempSync(join(tmpdir(), "pi-trace-report-"));
  try {
    const path = join(dir, "trace.jsonl");
    writeFileSync(path, records.map(JSON.stringify).join("\n") + "\n");
    const result = spawnSync(process.execPath, [cli, path], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
test("distinguishes suffixes, divergences, expected boundaries, and route correlations", () => {
  const first = request(1, { cached: 4000 });
  const second = request(2);
  second.find((record) => record.kind === "logical").components.push({ group: "input", index: 1, ...fp("a"), blocks: [] });
  assert.equal(report([...first, ...second]).pairs[0].classification, "unresolved_provider_candidate");
  const pair = report([...first, ...request(2, { input: "a", gaps: ["external_config_generation_unknown"] })]).pairs[0];
  assert.equal(pair.classification, "earlier_input_changed");
  assert.deepEqual(pair.firstDivergence, { group: "input", index: 0, change: "changed" });
  assert.equal(report([...first, ...request(2, { generation: "b" })]).pairs[0].classification, "expected_boundary");
  assert.equal(report([...first, ...request(2, { transport: "websocket" })]).pairs[0].classification, "prefix_stable_route_changed");
  for (const changed of [{ endpoint: "https://redirect.invalid" }, { redirected: true }, { status: 201 }]) {
    const next = request(2);
    const response = { kind: "http_response", endpoint: "https://example.invalid", redirected: false, status: 200 };
    first.push({ ...first[0], ...response });
    next.push({ ...next[0], ...response, ...changed });
    assert.equal(report([...first, ...next]).pairs[0].classification, "prefix_stable_route_changed");
    first.pop();
  }
});
test("uses each API's consumed cached field, not the first nonzero terminal", () => {
  const number = (value) => ({ present: true, type: "number", value });
  const nullField = { present: true, type: "null" };
  const cases = [
    { api: "anthropic-messages", events: [["message_start", { cache_read_input_tokens: number(20) }], ["message_delta", { cache_read_input_tokens: number(0) }]], expected: 0 },
    { api: "anthropic-messages", events: [["message_start", { cache_read_input_tokens: number(20) }], ["message_delta", { cache_read_input_tokens: nullField }], ["message_stop", {}]], expected: 20 },
    { api: "anthropic-messages", events: [["message_start", {}], ["message_delta", { cache_read_input_tokens: number(0) }]], expected: 0 },
    { api: "openai-completions", events: [["chat.usage", { cached_tokens: number(20) }], ["chat.usage", { cached_tokens: number(0) }]], expected: 0 },
    { api: "openai-completions", events: [["chat.usage", { cached_tokens: number(20), prompt_cache_hit_tokens: number(0), "prompt_tokens_details.cached_tokens": nullField }]], expected: 0 },
    { api: "openai-completions", events: [["chat.usage", { cached_tokens: number(20) }], ["chat.usage", {}]], expected: undefined },
    { api: "openai-completions", events: [["chat.usage", { cached_tokens: number(0) }], ["chat.usage", {}, { present: true, type: "array" }]], expected: undefined },
    { api: "openai-responses", events: [["response.completed", { "input_tokens_details.cached_tokens": number(20) }], ["response.completed", { "input_tokens_details.cached_tokens": number(0) }]], expected: 0 },
    { api: "openai-responses", events: [["response.completed", { "input_tokens_details.cached_tokens": number(20) }], ["response.completed", {}]], expected: undefined },
    { api: "openai-responses", events: [["response.completed", { "input_tokens_details.cached_tokens": number(0) }], ["response.completed", {}, { present: true, type: "array" }]], expected: undefined },
    { api: "openai-codex-responses", events: [["response.completed", { "input_tokens_details.cached_tokens": number(20) }], ["response.completed", { "input_tokens_details.cached_tokens": number(0) }]], expected: 20 },
  ];
  for (const { api, events, expected } of cases) {
    const baseline = request(1, { cached: 20 });
    const next = request(2, { cached: expected ?? 0 });
    baseline[0].api = api; next[0].api = api;
    const baselineTerminal = baseline.find((record) => record.kind === "terminal");
    if (api === "anthropic-messages") {
      baselineTerminal.type = "message_start";
      baselineTerminal.fields = { cache_read_input_tokens: number(20) };
    } else if (api === "openai-completions") {
      baselineTerminal.type = "chat.usage";
      baselineTerminal.fields = { cached_tokens: number(20) };
    }
    const terminal = next.find((record) => record.kind === "terminal");
    next.splice(next.indexOf(terminal), 1, ...events.map(([type, fields, usage = terminal.usage]) => ({ ...terminal, type, fields, usage })));
    const pair = report([...baseline, ...next]).pairs[0];
    if (expected === undefined) assert.equal(pair.classification, "unknown_reporting", api);
    else {
      assert.equal(pair.cached.value, expected, api);
      assert.equal(pair.overlapEstimate, 4000 - expected, api);
      assert.equal(pair.classification, expected === 0 ? "unresolved_provider_candidate" : "observed_prefix_stable", api);
    }
  }
});
test("keeps reused WebSocket handshake headers separate from later fallback headers", () => {
  const first = request(1, { cached: 20, transport: "websocket" });
  const second = request(2, { transport: "websocket" });
  const fallback = request(3, { purpose: "warming", transport: "websocket" });
  const generation = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const headers = { "openai-beta": fp("a") };
  for (const records of [first, second, fallback]) {
    records.splice(records.findIndex((record) => record.kind === "policy_headers"), 1);
    records.push({ ...records[2], kind: "send", generation, reused: true });
  }
  first.push({ ...first[2], kind: "handshake", generation });
  first.push({ ...first[2], kind: "policy_headers", headers });
  fallback.push({ ...fallback[2], kind: "handshake", generation });
  fallback.push({ ...fallback[2], kind: "policy_headers", headers });
  fallback.push({ ...fallback[2], kind: "attempt", attemptId: "cccccccc-cccc-cccc-cccc-cccccccccccc", transport: "sse" });
  fallback.push({ ...fallback.at(-1), kind: "policy_headers", headers: { "openai-beta": fp("b") } });
  assert.equal(report([...first, ...second, ...fallback]).pairs[0].classification, "prefix_stable_route_changed");
});
test("never turns missing cached detail or capture loss into an explicit-zero stable verdict", () => {
  const first = request(1, { cached: 4000 });
  assert.equal(report([...first, ...request(2, { raw: false })]).pairs[0].classification, "unknown_reporting");
  assert.equal(report([...first, ...request(2, { usageSource: false })]).pairs[0].classification, "unknown_reporting");
  assert.equal(report([...first, ...request(2, { captureGap: true })]).pairs[0].classification, "unknown");
  assert.equal(report([...first, ...request(2, { gaps: ["auth_generation_unknown"] })]).pairs[0].classification, "unknown_controls");
  const processGap = { v: 1, at: 3, processGeneration, kind: "coverage_gap", reason: "lifetime_limit", incomplete: true };
  assert.equal(report([...first, ...request(2), processGap]).pairs[0].classification, "unknown");
});
test("classifies real recorder JSON, including late policy headers, without printing content", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-trace-contract-"));
  const previous = process.env.PI_CACHE_TRACE_DIR;
  try {
    process.env.PI_CACHE_TRACE_DIR = root;
    for (const beta of ["cache-beta-a", "cache-beta-b"]) {
      const trace = createCacheTrace({ api: "openai-responses", provider: "fixture", id: "fixture", baseUrl: "https://example.invalid" }, {
        cacheTraceContext: { purpose: "parent", sessionId: "session", runtimeGeneration: "runtime", configGeneration: "config", authGeneration: 1 },
      }, "account");
      const body = { instructions: "PRIVATE_SENTINEL", input: [{ role: "user", content: "PRIVATE_SENTINEL" }] };
      trace.logical(body); trace.attempt("sse"); trace.wire(JSON.stringify(body)); trace.headers(new Headers({ "anthropic-beta": beta }));
      trace.terminal({ type: "response.completed", response: { id: "resp_contract", usage: { input_tokens: 4000, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } } });
      trace.parsed({ input: 4000, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 4001, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
    }
    const records = readdirSync(root).filter((name) => name.endsWith(".jsonl")).flatMap((name) => readFileSync(join(root, name), "utf8").trim().split("\n").map(JSON.parse));
    const value = report(records);
    assert.equal(value.pairs[0].classification, "observed_controls_changed");
    assert.ok(!JSON.stringify(value).includes("PRIVATE_SENTINEL"));
  } finally {
    if (previous === undefined) delete process.env.PI_CACHE_TRACE_DIR; else process.env.PI_CACHE_TRACE_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("keeps warming separate and rejects malformed inputs without echoing them", () => {
  assert.equal(report([...request(1), ...request(2, { purpose: "warming" })]).pairs.length, 0);
  const root = mkdtempSync(join(tmpdir(), "pi-trace-invalid-"));
  try {
    const path = join(root, "invalid.jsonl"); writeFileSync(path, "secret-sentinel\n");
    const result = spawnSync(process.execPath, [cli, path], { encoding: "utf8" });
    assert.equal(result.status, 2); assert.ok(!result.stderr.includes("secret-sentinel"));
    assert.equal(spawnSync(process.execPath, [cli, "--help"]).status, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
