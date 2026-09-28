---
name: add-llm-provider
description: Checklist for adding a new LLM provider to packages/ai. Covers provider factories, API implementations, lazy loading, compatibility registration, model generation, the full test matrix, coding-agent wiring, and docs.
---

# Adding a New LLM Provider (packages/ai)

This is the shared implementation and test checklist. A provider owns identity, models, auth, and request behavior; an API implements a wire protocol and can be shared by many providers. Reuse an existing API when it fits. Follow the existing factory/API/lazy-wrapper patterns, such as `src/providers/openai.ts` and `src/api/openai-responses.lazy.ts` under `packages/ai`.

## 1. Core Types (`packages/ai/src/types.ts`)

- Add the provider ID to `KnownProvider`.
- Only for a new API: add its identifier to `KnownApi`, define an options interface extending `StreamOptions` in the API implementation, and map it in `ApiOptionsMap`.

## 2. API Implementation (`packages/ai/src/api/`, only for a new API)

Create `<api-id>.ts` exporting:

- `stream()` returning `AssistantMessageEventStream` and `streamSimple()` mapping `SimpleStreamOptions`.
- The API-specific options interface.

Implement message/tool conversion from `TranscriptContext`, using `getInitialSystemMessage()`, `getCurrentTools()`, and `resolveTranscript()` as appropriate for the protocol. Parse responses into `AssistantMessageEvent` events (`start`, `text_*`, `thinking_*`, `toolcall_*`, `done`, `error`), with usage and stop reason on the resulting assistant message.

Add `<api-id>.lazy.ts` using the existing `lazyApi()` pattern so provider factories do not eagerly load SDKs. Add root-level `export type` re-exports in `src/index.ts` for public option types; keep the core entry side-effect free.

## 3. Model Generation (`packages/ai/scripts/generate-models.ts`)

- Add source fetch/parsing and map chat/tool-capable models to `Model`, including pricing, capability flags, and model-ID quirks.
- Regenerate through the script rather than editing generated files. It emits stable `src/providers/<id>.models.ts` wrappers and `src/models.generated.ts`; model values are hydrated into ignored `src/providers/data/<id>.json`, grouped by API. The wrappers derive exact model/API types from the JSON keys.
- If the provider also supports image generation, map its image models to `ImagesModel` through `scripts/generate-image-models.ts`.

## 4. Provider Factory and Compatibility

- Create `packages/ai/src/providers/<id>.ts` using `createProvider()` from `src/models.ts`: set `id`, display `name`, `baseUrl`, catalog, auth, and the lazy API wrapper. Mixed-API providers dispatch per model; see `src/providers/github-copilot.ts`.
- Use `envApiKeyAuth` for standard keys, a custom `ApiKeyAuth` for ambient credentials (AWS profiles, ADC), and `lazyOAuth` where an OAuth flow exists. Keep legacy credential detection in `src/env-api-keys.ts` aligned.
- Add the factory to `builtinProviders()` in `src/providers/all.ts`.
- For a new API, add its lazy wrapper to the exports and `BUILTIN_APIS` in `src/compat.ts`, which owns legacy global API registration. Do not register a duplicate API for a provider that reuses an existing protocol.
- `packages/ai/package.json` already exports `./providers/*` and `./api/*`; normal factory/API files use those wildcard subpaths without per-provider export entries.

## 5. Tests (`packages/ai/test/`)

- Always add the provider to `stream.test.ts` with at least one representative model, even if it reuses an existing API such as `openai-completions`. Include image-input coverage for vision models.
- Add the provider to the broader matrix where applicable: `tokens.test.ts`, `abort.test.ts`, `empty.test.ts`, `context-overflow.test.ts`, `unicode-surrogate.test.ts`, `tool-call-without-result.test.ts`, `image-tool-result.test.ts`, `total-tokens.test.ts`, `cross-provider-handoff.test.ts`.
- For `cross-provider-handoff.test.ts`, add at least one provider/model pair. If the provider exposes multiple model families (e.g. GPT and Claude), add at least one pair per family.
- Cover provider listing, auth resolution, and applicable image-limit metadata in `providers.test.ts`; use `lazy-module-load.test.ts` for affected lazy-loading boundaries.
- For non-standard auth, create a utility (e.g. `bedrock-utils.ts`) with credential detection.

Follow root `AGENTS.md` for test commands. Provider matrix tests can make real requests; use focused offline checks or the isolated `./test.sh` path for non-e2e validation.

## 6. Coding Agent (`packages/coding-agent/`)

- `src/core/model-resolver.ts`: add the default model ID to `defaultModelPerProvider`.
- Verify the factory's `name` and auth configuration: login options in `src/modes/interactive/interactive-mode.ts` read them from runtime providers. `src/core/model-registry.ts` also reads the provider's name; there is no separate display-name registry.
- `src/cli/args.ts`: add env var documentation.
- `README.md`: add provider setup instructions.
- `docs/providers.md`: add setup instructions, env var, and `auth.json` key.

## 7. Documentation and Changelog

- `packages/ai/README.md`: add to the supported providers table, document options/auth, and add env vars.
- Contributors leave changelogs alone. Authorized maintainers add the `packages/ai/CHANGELOG.md` entry under `## [Unreleased]` following [AGENTS.md](../../AGENTS.md#changelog).
