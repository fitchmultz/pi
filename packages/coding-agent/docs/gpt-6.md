# GPT-6

Pi registers Astra, Sol, and Luna on both routes: select `openai/gpt-6-sol` for the direct Responses API or `openai-codex/gpt-6-sol` for Codex subscription access, and substitute `astra` or `luna` as needed. The hosted features below apply to the direct OpenAI route.

## Ordinary sessions

Pi's GPT-6 model definitions enable image input, strict and grammar-constrained tools, deferred tool search, append-only tool declarations, encrypted reasoning replay, and cache-write accounting. Astra supports `low`, `medium`, `high`, `xhigh`, and `max`; Sol and Luna also support `off`. Unsupported `minimal` requests clamp to `low`.

With the default `transport: "auto"`, direct OpenAI sessions use WebSockets. User steering can reach a running response. Changing thinking level between responses uses `configuration_update` while preserving the original request's effort and cached prefix. Explicit SSE transport retains ordinary queued steering.

The built-in `read`, `grep`, `find`, and `ls` tools allow native asynchronous calls: the model can continue independent work while they run. Shell commands and file mutations remain synchronous. Extensions opt tools in with `async: true`; this is separate from local parallel execution. Tools still pass through Pi's normal argument validation, admission, and result hooks.

Pi preserves compatible encrypted reasoning when switching between Astra, Sol, and Luna on the same direct OpenAI route. It does not transfer opaque state across providers or model families.

## Context and pricing

Built-in direct OpenAI Astra, Sol, and Luna default to the 272,000-token short-context pricing tier. All three support a 1,050,000-token window and up to 128,000 output tokens. To use the full window, add a model override in `~/.pi/agent/models.json` for each model you need:

```json
{
  "providers": {
    "openai": {
      "modelOverrides": {
        "gpt-6-astra": { "contextWindow": 1050000 },
        "gpt-6-sol": { "contextWindow": 1050000 },
        "gpt-6-luna": { "contextWindow": 1050000 }
      }
    }
  }
}
```

Above 272,000 total input tokens, input and cache rates double and output rates increase by 50% for the entire request. The model definitions include these tiers. Pro mode and hosted subagents consume additional tokens; neither is enabled by default.

GPT-6 uses `prompt_cache_options.ttl: "30m"`, rather than the older `prompt_cache_retention` field. Pi uses the provider's implicit caching by default. `cacheRetention: "none"` requests explicit-only caching without breakpoints, preventing cache writes. Request hooks can place explicit breakpoints on reusable input content when an application needs finer control.

## Pro mode and reasoning context

Add this `samplingParams` object to the chosen model override:

```json
{
  "samplingParams": {
    "reasoning": {
      "mode": "pro",
      "effort": "high",
      "context": "all_turns"
    }
  }
}
```

Mode and effort are independent. `standard` is the ordinary mode; `pro` spends more model work on the answer. `context: "all_turns"` makes compatible earlier reasoning available; omit it to use the model's default, or use `current_turn` for only the active turn.

`samplingParams` replaces whole top-level request fields. Supplying `reasoning` overrides Pi's generated reasoning object, so include the desired effort. On supported standard-mode requests, Pi preserves the initial request effort and represents the effective change positionally. Pro mode uses request-level effort because positional updates are unsupported there.

## Hosted multi-agent mode

This is OpenAI's hosted orchestration, separate from a local subagent extension. Enable it explicitly for a direct OpenAI model:

```json
{
  "samplingParams": {
    "multi_agent": {
      "enabled": true,
      "max_concurrent_subagents": 3
    }
  }
}
```

Pi uses the beta Responses transport, executes client tools from all agents through the existing tool registry, and displays the root agent's answer. It preserves child output and encrypted collaboration state for continuation. WebSockets return completed client-tool results to the active response; HTTP returns them in the next request. Late injection rejection reuses the saved result rather than executing the tool again.

Every hosted agent receives the configured tools. The concurrency setting limits active descendants, not total agents, tree depth, or spend. Reported usage includes the hosted agents' combined token usage; Pi's context estimate is conservative and is not a per-root-agent measurement. Existing local subagent tools are not removed. Reasoning summaries and positional effort updates are unavailable in hosted multi-agent mode; server-side compaction is enabled by OpenAI. Native asynchronous tools require parallel tool calls to be disabled in this mode.

## Programmatic tool calling

OpenAI runs generated JavaScript in its hosted runtime. Pi executes only the client-owned tool calls returned by that runtime. Tools must explicitly allow programmatic callers; ordinary tools remain direct.

See [openai-programmatic-tools.ts](../examples/extensions/openai-programmatic-tools.ts) for a small runnable extension:

```bash
pi -e packages/coding-agent/examples/extensions/openai-programmatic-tools.ts --model openai/gpt-6-sol
```

The example adds one read-only file-information tool and appends the hosted declaration without replacing Pi's tools. Ask it to compare two file sizes using a program.

Tool definitions use `allowedCallers: ["direct", "programmatic"]` and an `outputSchema` describing the JSON string returned in `content`. Tool `details` are not the program's result. Async tools cannot also be programmatic. Deferred tools must be loaded before a program tries to call them.

## Structured answers

Structured answer output is separate from strict function arguments. Set `samplingParams.text.format` for a task that requires a schema:

```json
{
  "samplingParams": {
    "text": {
      "format": {
        "type": "json_schema",
        "name": "answer",
        "strict": true,
        "schema": {
          "type": "object",
          "properties": { "answer": { "type": "string" } },
          "required": ["answer"],
          "additionalProperties": false
        }
      }
    }
  }
}
```

A refusal or truncated response is still possible. Pi preserves that outcome rather than manufacturing schema-valid JSON.

## Native compaction

Pi's `/compact` and automatic summary policy remain available. To opt into OpenAI's native compaction, configure the model's `samplingParams`:

```json
{
  "samplingParams": {
    "context_management": [{ "type": "compaction", "compact_threshold": 200000 }]
  }
}
```

Choose a threshold that fits the model's context window. Native automatic compaction disables positional effort updates. Pi preserves the returned opaque compaction items across continuation and session restore; it does not turn them into human-readable summaries or discard another agent's context when a hosted child compacts.

Pi and provider compaction are independent policies. If you deliberately choose provider-managed windows, set `"compaction": { "enabled": false }` in the relevant [settings scope](settings.md#compaction) so Pi does not summarize first. This also affects other models in that scope. With Posthorse installed, it disables Posthorse's checkpoint reminders and automatic fresh-window rollover too. Manual `/compact` remains available; leave the existing setting enabled to retain the Pi/Posthorse workflow.

For an explicit native compaction request, an extension can append `{ "type": "compaction_trigger" }` as the final request input item. Pi re-establishes the desired positional effort after that boundary. The standalone `/responses/compact` endpoint is not wrapped by Pi; it rejects multi-agent mode and histories containing configuration updates.

## Computer use and monitoring

Image-bearing computer-use tools continue through their existing extensions and platform runtimes. Enabling GPT-6 does not install a second desktop executor or make Pi execute native Responses `computer_call` actions.

A provider error with code `misalignment_policy_violation` stops further dispatch and automatic continuation of that workflow, including retry and compaction recovery. Pi preserves the error and available request/response identifiers for review. Already completed actions are not undone.

## References

- [GPT-6 model guide](https://developers.openai.com/api/docs/guides/latest-model)
- [Async tools](https://developers.openai.com/api/docs/guides/async-tool-calling) and [steering](https://developers.openai.com/api/docs/guides/steering)
- [Reasoning](https://developers.openai.com/api/docs/guides/reasoning) and [prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [Programmatic tools](https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling), [multi-agent](https://developers.openai.com/api/docs/guides/responses-multi-agent), and [compaction](https://developers.openai.com/api/docs/guides/compaction)
