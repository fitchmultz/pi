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
  id: string;
  name: string;
  arguments: JsonObject;
  thoughtSignature?: string;
  namespace?: string;
}
```

`thoughtSignature` is provider-specific. `namespace` identifies an OpenAI Responses namespace for dynamically loaded or namespaced calls. Pi's callable tool references use public names. [On-demand instruction groups](instruction-groups.md) expose full extension-owned instructions without widening callable permissions.

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
  timestamp: number;
}
```

The leading system message declares the initial prompt and tools. Later system messages can append instructions, replace or remove named prompt sections, and add or remove tools. Replaying them in order yields the current state.

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
  thinkingLevel?: ModelThinkingLevel;
  webSearch?: ResponsesWebSearchMetadata;
  endTurn?: boolean;
  timestamp: number;
}
```

`responseModel` records a concrete provider response model when it differs from the requested model. `responseId`, `providerThinkingLevel`, `diagnostics`, and `rawStopReason` preserve provider or runtime details.

`thinkingLevel` is the requested Pi thinking level. `webSearch` records provider-reported hosted web actions and citations, not fetched page content. `"pending"` appears during streaming; it is not a durable native execution snapshot. `"deferred"` remains a provider stop reason, but conversion refuses unfinished deferred legacy responses.

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
type ToolResultMessage<TDetails = JsonValue> = IsJsonCompatible<TDetails> extends true ? {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  nestedCalls?: NestedToolCalls;
  content: (TextContent | ImageContent)[];
  details?: JsonRepresentation<TDetails>;
  usage?: Usage;
  isError: boolean;
  timestamp: number;
} : never;
```

`details` is JSON-compatible tool-specific data. `nestedCalls` has `{ calls: NestedToolCallRecord[], complete: boolean }`; each record names a nested tool and its status, but not its result. It is not model input. Optional `usage` reports nested model work and contributes to full-session statistics, separately from the main model call.

### Provider request diagnostics

Assistant diagnostics are redacted provider/runtime observations, not model input. A request's timing, transport, service-tier, and byte-count observations do not establish network receipt, billed tokens, or provider cache hits. Codex WebSocket transport failures can retain `provider_transport_failure` diagnostics; see [Codex WebSocket recovery](websocket-recovery.md).

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
