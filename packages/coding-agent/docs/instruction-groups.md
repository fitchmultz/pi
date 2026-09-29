# On-demand full instructions

The replaceable builtin `discover_tools` lists instruction groups. Calling it with
`{ "enable": ["browser"] }` returns the group's **full** owner-provided instructions.
Only subsequent model turns can use its tools. Listing alone does not enable a group.

Discovery changes declaration visibility, not permissions. It never activates an
inactive tool, bypasses `--tools`/exclusions, changes exposure, or makes a hidden tool
callable. Available groups have at least one tool in the permitted declared or
callable loadout. A group's inactive optional tools remain inactive after discovery.
`discover_tools` is model-only: codemode cannot call it internally to bypass the
required model-read boundary. Direct and nested grouped calls share the same gate.

The CLI loads this builtin automatically. SDK hosts opt in by including
`instructionGroupsExtension` from `@earendil-works/pi-coding-agent` in their
resource loader's `extensionFactories`, alongside the owner extensions. Without
it, owners use their eager fallback.

## Owner registration and stock fallback

Register tools normally. Subscribe during the extension factory, before session
startup. The builtin emits a synchronous `pi:instruction-groups` collector at
`session_start`. Do not await before registering. This structural contract needs no
fork-specific runtime import:

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
  // Register browser tools here, using their existing exposure/defaultActive policy.
  const fullInstructions = (ctx: ExtensionContext) =>
    `Full browser instructions, safety rules, and project guidance for ${ctx.cwd}.`;
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

Names must be unique, descriptions and instruction text nonempty, and tool names
must not include `discover_tools`. An instruction function is synchronous and
should return stable text for a given session/project configuration. Return all
instructions, including safety rules, usage guidance, and relevant project rules;
do not leave duplicate eager `promptGuidelines` on the managed tools. Stock Pi, or
a session where `discover_tools` is inactive/excluded, uses the owner's eager
fallback. A replacement discover tool must implement this collector contract to
opt into managing owners; otherwise owners remain eager.

## Persistence and request boundaries

Only enabled names are stored in custom `pi:instruction-groups` entries. Full text
is delivered in discovery results and appended to the prompt on subsequent runs.
Startup and tree navigation reconstruct names from the selected raw branch, not
from compacted context or unrelated branches. Declaration recalculation preserves
the exact active tool names.

After compaction, a request-local hidden custom message is inserted immediately
after the latest compaction summary. It contains only groups enabled **at that
boundary**, reconstructed from the raw branch. Groups discovered later retain
their later tool-result anchor. Ordering is by group name; the repair timestamp is
the compaction timestamp. The leading system message and tool state are untouched.
This also works when automatic compaction follows discovery within the same run;
no queued `sendMessage` repair is used.

Readiness clears at every turn start and is granted only when the request context
contains the full current instruction section. A same-assistant batch containing
discovery and an action is blocked even when the discovery executes first. Owners
whose instruction text changes must rediscover it if no current instruction anchor
survives. As with other request-transforming extensions, later
`context_with_system` handlers must preserve these instructions; this builtin
cannot validate changes made after its handler runs.

See [Extensions](extensions.md) for public loadout and lifecycle APIs.
