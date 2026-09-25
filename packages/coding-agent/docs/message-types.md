# Message Types

Pi uses `AgentMessage` values in SDK state, lifecycle events, RPC responses, and persisted session message entries. This page defines those shared messages and their content blocks.

Message timestamps are Unix timestamps in milliseconds. They are different from the ISO 8601 timestamps on [session entries](session-format.md#entry-base).

Source definitions:

- [`packages/ai/src/types.ts`](https://github.com/earendil-works/pi/blob/main/packages/ai/src/types.ts) defines provider-facing messages and content blocks.
- [`packages/agent/src/types.ts`](https://github.com/earendil-works/pi/blob/main/packages/agent/src/types.ts) defines the extensible `AgentMessage` union.
- [`packages/coding-agent/src/core/messages.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/messages.ts) adds coding-agent message roles.

## Content blocks

### TextContent

```typescript
interface TextContent {
  type: "text";
  text: string;
  textSignature?: string;
}
```

`textSignature` contains provider-specific message metadata. Treat it as opaque.

### ImageContent

```typescript
interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}
```

`data` is base64-encoded image data. `mimeType` identifies its media type, such as `image/png` or `image/jpeg`.

### ThinkingContent

```typescript
interface ThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
}
```

Thinking signatures contain provider-specific replay data. Treat them as opaque. A redacted block can have no visible thinking text while retaining an encrypted payload in `thinkingSignature`.

### ToolCall

```typescript
interface ToolCall {
  type: "toolCall";
  kind?: "toolSearch";
  id: string;
  name: string;
  arguments: JsonObject;
  thoughtSignature?: string;
  namespace?: string;
  async?: boolean;
  responsesItem?: ResponseFunctionToolCall | ResponseCustomToolCall;
  executionStarted?: boolean;
  executionArguments?: JsonObject;
  executionDetached?: boolean;
}
```

`thoughtSignature` is provider-specific. Identity is the exact `(namespace, name)` pair across registration, transport, execution, and replay. Function-only providers use collision-checked aliases without changing the saved identity. `responsesItem` retains the original provider item while `executionArguments` records validated, preflight-adjusted input. See [native asynchronous tools](sdk.md#native-asynchronous-tools-and-steering) for execution and recovery.

## Usage

Assistant messages always contain usage. Tool results can contain usage when the tool performed nested model work.

```typescript
interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  reasoning?: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}
```

When present, `reasoning` is already included in `output`; do not add it again. `cacheWrite1h` is the subset of `cacheWrite` written with one-hour retention. See [Task cost measurement](task-cost.md) for offline whole-task accounting and the distinction between recorded estimates and actual billing.

## Base messages

### SystemMessage

```typescript
interface SystemMessage {
  role: "system";
  content: string | TextContent[];
  sections?: Record<string, string | null>;
  toolsAdded?: Tool[];
  toolsRemoved?: ToolReference[];
  replace?: boolean;
  timestamp: number;
}
```

The leading system message declares the initial prompt and tools. Later system messages can append instructions, replace or remove named prompt sections, and add or remove tools. Replaying them in order yields the current state. A message with `replace: true` discards the earlier state and establishes a complete new baseline.

### UserMessage

```typescript
interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}
```

### AssistantMessage

```typescript
interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  api: string;
  provider: string;
  model: string;
  responseModel?: string;
  responseId?: string;
  providerThinkingLevel?: string;
  diagnostics?: AssistantMessageDiagnostic[];
  usage: Usage;
  stopReason: "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";
  deferred?: DeferredHandle;
  errorMessage?: string;
  rawStopReason?: string;
  toolExecutionFailed?: boolean;
  endTurn?: boolean;
  timestamp: number;
}
```

`responseModel` records a concrete provider response model when it differs from the requested model. `responseId`, `providerThinkingLevel`, `diagnostics`, and `rawStopReason` preserve provider or runtime details.

`toolExecutionFailed` is local execution bookkeeping derived by session projection from the original response's foreground failure receipts on the active branch. It preserves that response's fresh-window veto when those receipts leave model context. It is not provider input.

`"pending"` appears during streaming and in durable assistant snapshots marked `checkpoint: true`. Completed responses use ordinary message entries with terminal stop reasons. Checkpoints are not additional billable responses; see [session snapshots](session-format.md#sessionmessageentry).

A `"deferred"` response has a `DeferredHandle` with the provider data needed to retrieve it:

```typescript
interface DeferredHandle {
  provider: string;
  modelId: string;
  api: string;
  id: string;
  expiresAt?: number;
  pollAfterMs?: number;
  data?: JsonValue;
}
```

### ToolResultMessage

```typescript
interface ToolResultMessage<TDetails = any> {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  namespace?: string;
  toolCallKind?: "toolSearch";
  toolsAdded?: Tool[];
  elapsedMs?: number;
  executionSkipped?: boolean;
  content: (TextContent | ImageContent)[];
  details?: TDetails;
  usage?: Usage;
  isError: boolean;
  timestamp: number;
}
```

`details` is tool-specific. Optional `usage` reports nested model work and contributes to full-session statistics, separately from the main model call. `elapsedMs` measures executor time only; blocked calls omit it. `toolsAdded` holds core-resolved discovery declarations, including `[]` for an empty native search result.

`executionSkipped: true` identifies a foreground scheduling failure, such as truncated arguments or interrupted ordered execution. Its error vetoes a sibling fresh-window request after restore just as it does live. Native background failures, including preflight blocks, do not acquire that veto. Older results without the field retain their existing classification.

### Provider request diagnostics

Codex, OpenAI Responses, and Azure Responses persist `provider_request` diagnostics on successful and failed messages. Details contain allowlisted transport, byte-count, socket/recovery, service-tier, and timing facts; they are not model input or ordinary transcript notices.

- `timingOrigin: "adapter_start"` starts inside the adapter after earlier runtime preparation. Offsets use a monotonic clock; `onPayloadMs` and `connectMs` are durations, while socket/application-event ages are ages. Payload-hook time includes `before_provider_request`, not all extension work.
- `headersMs` marks fetch/SDK response availability before `onResponse`. Event times measure adapter consumption, including reasoning/tool deltas, rather than network arrival or provider-only latency. `finishedMs` precedes later hooks/persistence.
- Counters cover that invocation. SSE counts fetch/SDK calls, not redirects. Recovery retains first-event times and latest socket/attempt facts, which may describe different attempts. Missing fields mean unobserved boundaries.
- OpenAI/Codex `requestShape` measures serialized UTF-8 bytes for instructions, tools and input, with allowlisted input-role/type buckets (including reasoning), tool count, and the first 128 top-level tool-definition sizes by ordinal. It stores no prompt, schema or tool-name content. Value sizes include JSON quoting/escaping but exclude enclosing keys/separators; they are not billed token counts.
- `requestShapeScope: "full_request"` measures Codex's post-hook JSON or the OpenAI SDK's serialized SSE body. `"websocket_logical_body"` reuses OpenAI's serialized continuation components before delta selection, excluding `stream`; stateful serializers may produce different later wire values. `fullBodyBytes` follows this scope. Azure does not yet report shape measurements.
- Codex `websocketSendBytes` counts the UTF-8 payload passed to send, including `response.create`, after delta selection; `sseSendBytes` counts the optionally compressed fetch body. Neither proves network delivery or reduced provider-billed context.
- `requestedServiceTier` is post-hook input; `returnedServiceTier` is the recognized raw terminal tier before pricing. `fast` and `priority` stay distinct; missing/null/unrecognized tiers are `unknown`. A request for priority does not prove delivery.
- Close code/cleanliness and local timeouts are independent evidence, not error classifications. Pi captures synchronous closes without waiting for late ones or changing retry policy. See [WebSocket diagnostics](websocket-recovery.md).

## Coding-agent messages

The coding-agent package extends `AgentMessage` with four roles.

### BashExecutionMessage

Created by direct shell commands, including the RPC [`bash`](rpc-commands.md#bash) command. It is not an LLM tool result.

```typescript
interface BashExecutionMessage {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
  excludeFromContext?: boolean;
  timestamp: number;
}
```

Unless `excludeFromContext` is true, Pi converts this message to user-role text before the next model request.

### CustomMessage

Created when an extension sends a context message.

```typescript
interface CustomMessage<T = unknown> {
  role: "custom";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  display: boolean;
  details?: T;
  timestamp: number;
}
```

Pi converts its content to a user message for model requests. `display` controls terminal rendering; `details` is not sent to the model.

### BranchSummaryMessage

```typescript
interface BranchSummaryMessage {
  role: "branchSummary";
  summary: string;
  fromId: string | null;
  timestamp: number;
}
```

Pi creates this context message from a persisted `branch_summary` entry.

### CompactionSummaryMessage

```typescript
interface CompactionSummaryMessage {
  role: "compactionSummary";
  summary: string;
  tokensBefore: number;
  timestamp: number;
}
```

Pi creates this context message from a persisted `compaction` entry.

## AgentMessage union

In the coding agent, the union is equivalent to:

```typescript
type AgentMessage =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | BashExecutionMessage
  | CustomMessage
  | BranchSummaryMessage
  | CompactionSummaryMessage;
```

At the lower-level agent package, `AgentMessage` is `Message | CustomAgentMessages[keyof CustomAgentMessages]`. Applications can add roles through TypeScript declaration merging, so consumers should tolerate unknown custom roles when they accept messages from an augmented host.
