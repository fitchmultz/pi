# Passive cache investigation

Temporary, opt-in local metadata tracing for the native Completions, Responses, Anthropic and ChatGPT Codex adapters. It observes requests already being made; it does not send probes, enable warming, change cache keys, pin transports or change usage accounting.

## Enable and stop

Set `PI_CACHE_TRACE_DIR` to a dedicated private directory before starting a runtime containing this source change:

```sh
mkdir -m 700 /private/path/cache-study
PI_CACHE_TRACE_DIR=/private/path/cache-study pi
```

Build, deployment and activation require their own authorization. Existing processes continue using their loaded code. `/reload` refreshes extensions, not native adapter code. Child processes inherit the variable; SDK hosts can set it before their first request. With the variable unset or empty, the recorder performs no tracing disk I/O or hashing.

Unset the variable and quit every traced process to stop. The recorder opens and closes each write; it holds no persistent file handles. Delete the dedicated directory, including `investigation.key`, after extracting the needed private evidence. Do not reuse a directory/key for a different investigation or publish either the key or records.

Collection stops 24 hours after key creation, at 16 MiB per process file, or if a record exceeds 256 KiB. There are at most 64 process slots; fingerprints cover at most 2,048 logical components and 2,048 content blocks. Limits stop recording and emit a coverage gap when possible; they never block model requests. Expired or unsafe storage is refused, not silently renewed. Records are not automatically purged: the owner must remove them within the investigation's 24-hour retention window, or explicitly retain selected evidence separately. A process that exits cannot enforce later disk deletion.

## Privacy and fidelity

The dedicated directory must be mode `0700`; files and the shared random HMAC key are mode `0600`. Unsafe permissions, symlinks, hard-linked files, replaced files or observer failures disable collection without changing requests. Existing directory permissions are not changed for you.

Records contain keyed digests and lengths, not prompts, tool arguments, schemas, image bytes, auth tokens, cookies, full headers, environment dumps or proxy URLs. Account identity is hashed only where already resolved for the actual request; credentials are never resolved solely for tracing. Only endpoint origins, fixed protocol enums, finite numeric metadata and syntactically restricted response/request IDs remain readable. HMACs correlate content inside this investigation, not across independent keys.

Late logical payloads are captured from the SDK's serialized HTTP body after payload hooks and native fitting, or from Codex's native serialized logical body. This avoids an extra serialization of caller-owned payload objects. Actual HTTP bodies and WebSocket envelopes have separate digests. A custom fetch implementation can still mutate arguments after the observer; this has an explicit coverage gap, not a physical-network completeness claim. Codex records individual attempts, connection generations/reuse/age, continuation decisions, recognized retries and sticky SSE fallback. Reused connections retain their original handshake generation; newly constructed headers are not described as retransmitted. Raw terminal usage preserves field absence versus numeric zero; parsed usage records the attempt whose terminal usage was actually consumed. Existing parsers still normalize usage as before.

SDK provenance records purpose, session, active leaf, compaction/branch-summary window, selected versus physical model, process/session runtime and reload generations, catalog fingerprints, loaded extension order/failures, and entry-file snapshots. Actual declaration fingerprints come from the native serialized logical request, not a second serialization of the SDK's caller-owned schemas. Entry bytes on disk are not proof of the complete module graph that is currently loaded. Builtin/inline factories may have no entry digest. External fast/verbosity configuration and auth generations remain unknown unless the calling owner supplies an already-resolved annotation. No new general extension event or policy framework is added.

Warming is tagged separately while retaining the original request's identity. Native summaries are tagged `summary`; ordinary requests distinguish `parent` and `child`. Unknown routing, custom providers, unsupported adapters and nested calls without an explicit owner annotation cannot establish complete provenance. Custom injected Anthropic clients have explicit logical/wire-coverage gaps. The trace is not a universal observer of wrappers or server internals.

## Offline classification

From the repository root, supply only the trace files you want analyzed:

```sh
node scripts/cache-trace-report.mjs /private/path/cache-study/trace-*.jsonl > /private/path/report.json
node scripts/cache-trace-report.mjs --help
```

The read-only CLI calls no APIs, reads no credentials or investigation key, and prints JSON. It pairs requests by investigation-key session identity and purpose. New input suffixes do not count as earlier-prefix divergence; changed earlier items, blocks, instructions and top-level declarations are located separately from controls/cache markers. Raw cached-field presence and consumed-attempt provenance take precedence over normalized zero.

Report classes distinguish incomplete capture/reporting, expected model/policy/account/config/reset/runtime boundaries, earlier semantic changes, changed controls, and stable observed prefixes correlated with transport changes. Unobserved auth/config/module provenance prevents a complete-client-stability verdict. An explicit zero with complete observed client controls remains an unresolved provider/reporting candidate, not proof of eviction or transport-induced cache loss. Server routing, hidden subscription policy and accounting require provider diagnostics.

`overlapEstimate` is `max(0, min(previous prompt, current prompt) - raw cached tokens)`. It is an estimator, not measured cache-key divergence, avoidable token waste, a savings forecast or subscription billing. First requests have no baseline. Warming and summaries are never mixed with ordinary session pairs. No lifetime cache-hit percentage is an acceptance target.

## Verification and evidence limits

Offline owner tests cover real native serialization, terminal presence, first-terminal behavior, silent retry/fallback, delta/full envelopes, late hook mutation, privacy/storage failure and SDK provenance. Required repository checks do not make real provider calls. See [Restart](restart.md#validation) for the persistent guidance regression and [SDK](sdk.md) for lifecycle ownership.

No natural request measurements are created by installing this source change. Representative GLM wake/tool/user, Sol discovery/reload and Codex short-gap pairs must come from later ordinary authorized work. Historical unrecorded bodies and server-internal cache identity cannot be reconstructed by this recorder. Remove the temporary plumbing when those questions are answered.
