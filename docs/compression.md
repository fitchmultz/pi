# Transport compression

This is lossless transport compression, not conversation summarization. It reduces
upload bytes without changing prompts, token usage, context limits, or cache keys.
No end-to-end latency or billing improvement is claimed by the offline tests.

## Request bodies

Automatic compression is endpoint-specific, not inferred from a provider name or
an OpenAI/Anthropic-compatible JSON schema.

| Adapter / destination | Encoding | Boundary |
| --- | --- | --- |
| Anthropic Messages at `https://api.anthropic.com/v1/messages` | gzip | API key, OAuth and header/federation auth; Node/Bun native gzip, or the Web `CompressionStream` when available |
| OpenAI Responses at `https://api.openai.com/v1/responses` | zstd | Native runtime support required; public Responses endpoint, not Chat Completions, Azure or compatible gateways |
| Codex SSE at `https://chatgpt.com/backend-api/codex/responses` | zstd | Existing Codex compression, now restricted to the canonical resolved endpoint; WebSocket JSON frames are unchanged |

For the new Anthropic and public OpenAI paths:

- Only serialized JSON POST bodies of at least 1 KiB are candidates. Compression
  is asynchronous, and the original body is retained if compression fails or does
  not make it smaller. Native gzip uses level 1; native zstd uses level 3.
- OpenAI's documented limits are checked before sending compressed bytes: both
  representations must be at most 128 MiB, and decompression must not expand the
  compressed body by more than 100 times. Otherwise the ordinary JSON request is
  sent; normal provider request/context limits still apply.
- Existing `Content-Encoding` headers are respected. Set `Content-Encoding: identity`
  in provider/model/request headers to disable automatic compression, for example
  for an inspecting proxy or custom fetch implementation that requires plain JSON.
- Uncompressed `Content-Length` is removed when the body changes; fetch derives
  the correct wire length. Signals, auth headers, payload hooks, retries, response
  hooks and SSE parsing keep their existing contracts.
- Injected Anthropic SDK clients keep ownership of their transport. SDK token
  exchanges, multipart uploads, binary bodies, GET requests, other hosts/paths and
  unqualified gateway endpoints are not compressed.
- No automatic retry is added when a server rejects compression. Resending a POST
  without knowing whether it was consumed can duplicate work. Existing configured
  provider retries remain unchanged.
- Optional private cache tracing records the final logical JSON and the actual
  compressed wire bytes separately, using fingerprints rather than prompt text.

## Support evidence

Audited 2026-10-19 against the fork's pinned SDKs, Anthropic 0.133.0 and OpenAI
7.32.0. Neither SDK automatically compresses these request bodies.

- Anthropic's [official Claude Code 2.1.300 changelog](https://github.com/anthropics/claude-code/blob/ef7bfdca55d906929fe6b782025b93758c325074/CHANGELOG.md#L187)
  explicitly describes gzip uploads to `api.anthropic.com`. The official
  [`@anthropic-ai/claude-code-linux-x64` 2.1.303 artifact](https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/2.1.303)
  uses the same host-gated compression wrapper before choosing API-key or OAuth
  authentication. This is official-client evidence, not a published guarantee for
  arbitrary proxies. An unauthenticated Messages OPTIONS preflight also allowed
  `content-encoding`; no authenticated live generation was used for qualification.
- OpenAI's [production best practices](https://developers.openai.com/api/docs/guides/production-best-practices#compress-request-bodies)
  explicitly show `Content-Encoding: zstd` on public `/v1/responses` and specify
  the size and expansion-ratio limits above.
- The [official Codex client](https://github.com/openai/codex/blob/main/codex-rs/core/src/client.rs)
  selects zstd for its OpenAI Codex backend. That does not establish support for
  arbitrary URLs configured through `baseUrl`.

## Audit of other paths

| Area | Decision |
| --- | --- |
| HTTP responses, catalog downloads, MCP responses | Leave negotiation and decompression to the maintained fetch transport. The CLI's pinned Undici already advertises supported gzip/deflate/Brotli/zstd encodings over HTTPS and decodes them. Do not double-decompress or force unsupported `Accept-Encoding` values. Catalogs also use ETags. |
| Chord | Existing large-payload raw DEFLATE and browser decompression remain. Do not stack another WebSocket compression layer or enable packed input from untrusted clients. Coding-agent does not use Chord's host/link transport. |
| Packages, source archives, binary releases, tool downloads, bug-report ZIPs | Already use gzip/tgz/ZIP/DEFLATE in their consumer-supported formats. Avoid recompressing those assets. |
| MCP requests, stdio, Env framing, SSH | No new codec or unnegotiated request encoding. Preserve the peer protocol; SSH settings remain owned by the native client configuration. |
| Bedrock Converse, Gemini Developer API, Azure, other compatible hosts | No verified request-compression contract for these exact adapter endpoints. Generic SDK compression options or response compression are not evidence of request support. |
| Vertex | Google's Java client has request-gzip precedent. The pinned GenAI JavaScript SDK exposes `HttpOptions.fetch`, but using it disables the SDK's no-timeout dispatcher. Leave Vertex unchanged rather than trade compression for a long-response timeout regression or duplicate SDK transport internals. |
| Session-share and report uploads | No verified receiver request-compression contract; leave unchanged. |

## Verification and measurement

Offline tests exercise real SDK serialization, lossless round trips, endpoint
exclusions, runtime fallback, cancellation, retries, federation token reuse,
caller-owned headers, cache-trace fidelity, and a local HTTP receiver with gzip
SSE responses. Delayed-compressor tests ensure cancellation settles before queued
native work completes. A native Chromium Web `CompressionStream` smoke test also
verified a lossless gzip round trip. No paid model calls are required.

```sh
./test.sh -- node node_modules/vitest/dist/cli.js --run --root packages/ai \
  test/anthropic-request-compression.test.ts test/openai-request-compression.test.ts \
  test/openai-codex-stream.test.ts test/cache-trace.test.ts
npm run check
./test.sh
```

An initial capture through the real Anthropic SDK used 1,500 synthetic TypeScript
function declarations in a conversation: **171,937 bytes of JSON → 9,208 bytes of
gzip (94.6% smaller)** at native level 1. This is an upload-size example, not a
representative latency benchmark; savings depend on the actual conversation.
