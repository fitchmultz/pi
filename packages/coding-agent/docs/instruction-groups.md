# On-demand full instructions

The replaceable `builtin:instruction-groups` extension adds `discover_tools`.
Calling it without arguments lists available instruction groups. Calling it with
`{ "enable": ["browser"] }` returns the group's **full** owner-provided instructions.
Listing alone does not enable a group. Only subsequent model turns can use its tools.

At prompt start, discovery deactivates selected tools in groups not yet enabled.
Enabling restores only those previously selected tools for the next request; it does
not activate optional tools, bypass `--tools` or exclusions, change exposure, or make
hidden tools callable. Declarations are added at that request's position, preserving
the earlier cache prefix instead of unhiding historical declarations. Available
groups have at least one previously selected or callable tool. Direct and nested
calls share the read gate.

The builtin uses the fork's narrow `refreshTools()` seam to add restored declarations
at the current request position without rewriting historical cache prefixes. Owner
registration uses the structural extension-event contract below; the builtin itself
is not portable to official 1.0 without an equivalent declaration-refresh seam.

Suppression runs at prompt starts; another extension can add a tool mid-batch, which
is a positional declaration change and does not rewrite the earlier cache prefix.
`discover_tools` is model-only, so codemode cannot call it internally.

The CLI loads this builtin by default. Disable it with `--exclude-tools discover_tools`,
`--no-extensions`, or `"extensions": ["-builtin:instruction-groups"]` in settings.
An explicit `--tools` allowlist must include `discover_tools` to use discovery.
SDK hosts opt in by adding the exported `instructionGroupsExtension` factory to
`DefaultResourceLoader`'s `extensionFactories`, alongside owner extensions, then
calling `session.bindExtensions()`. See [SDK](sdk.md).

## Owner registration and eager fallback

Register tools normally, with their existing exposure and activation policy.
Subscribe during the extension factory, before session startup. At `session_start`
the builtin emits `pi:instruction-groups` with a synchronous collector:

```typescript
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Collector = {
  register(group: {
    name: string;
    description: string;
    tools: string[];
    instructions(ctx: ExtensionContext): string;
  }): void;
  isManaged(): boolean;
};

export default function (pi: ExtensionAPI) {
  // Register the browser tool here.
  const fullInstructions = (ctx: ExtensionContext) =>
    `Full browser safety rules, usage guidance, and project rules for ${ctx.cwd}.`;
  let isManaged = () => false;
  pi.events.on("pi:instruction-groups", (value) => {
    const collector = value as Collector;
    collector.register({
      name: "browser",
      description: "Browse and interact with web pages",
      tools: ["browser"],
      instructions: fullInstructions,
    });
    isManaged = collector.isManaged;
  });
  pi.on("before_agent_start", (event, ctx) => {
    if (!isManaged()) {
      event.systemPromptOptions.appendSystemPrompt += `\n\n${fullInstructions(ctx)}`;
    }
  });
}
```

Do not await before registering. Names must be unique, descriptions and instruction
text nonempty, and tool names must not include `discover_tools`. Instruction functions
are synchronous and should return stable text for a given session/project configuration.
Return all safety, usage, and project instructions; avoid duplicate eager
`promptGuidelines` on managed tools. The exported `InstructionGroup` and
`InstructionGroupCollector` types are optional; owners can use the structural contract
above without importing a fork-specific runtime value.

When `discover_tools` is inactive or absent, the builtin does not manage instructions
or gate calls, and owners supply their eager fallback. A replacement discover tool
must implement the collector contract to manage owners; otherwise owners remain eager.

## Persistence and request boundaries

Enabled names and the temporarily inactive selected tools are stored in custom
`pi:instruction-groups` session entries.
Full text is returned by discovery and appended to the system prompt on subsequent
runs. Startup, resume, reload, and tree navigation replay the selected raw branch,
not compacted context or abandoned branches. Requests consume only newly appended
entries through public session APIs, without a full-history walk on every request.
Replaying this state restores the same selection without activating optional tools.

After compaction, a request-local hidden custom message is inserted immediately
after the latest compaction summary. It restores full instructions for groups enabled
**at that boundary**, in name order, with the compaction timestamp. Later discoveries
keep their later tool-result anchor. The system message and tool state are untouched.
This also repairs automatic compaction following discovery in the same run.

Readiness clears at each turn and requires the full current instruction section in
the request's effective system prompt, a successful discovery result, or the repair
message. Same-assistant discovery and action calls are blocked, even in sequential
execution. If an owner's text changes and no current instruction anchor survives,
rediscover it. Later `context_with_system` handlers must preserve these instructions;
the builtin cannot validate transformations made after its own handler.

See [Extensions](extensions.md) for public loadout and lifecycle APIs and
[Message Types](message-types.md) for request-local custom messages.
