# Extension-owned tool discovery

Tool discovery reduces unused integration declarations without disabling extensions or shortening their instructions. Extensions attach capability metadata to their actual tool definitions. Pi derives the catalog from the final permitted registrations; users do not maintain tool lists or provider lists, and no configuration is required.

For example, a dependency audit need not receive browser schemas. A task needing the browser calls `discover_tools({ enable: ["browser"] })`; Pi activates the group's entry tools and includes their complete schemas, guidelines, and associated prompt sections on the next request. Discovery executes no integration action. Actual calls retain normal validation, tool hooks, approvals, cancellation, and rendering.

## Extension contract

Share a descriptor beside the extension's registrations and attach it with the optional `ToolDefinition.discovery` field:

```typescript
const group = {
  name: "browser",
  description: "Browse and verify web pages",
  sections: ["browser_manual"],
} as const;

pi.registerTool({
  ...browserTool,
  ...{ discovery: { group, role: "entry" as const } },
});
pi.registerTool({
  ...advancedBrowserTool,
  ...{ discovery: { group, role: "advanced" as const } },
});
```

`ToolDiscoveryGroup` and `ToolDiscovery` are exported for fork-native authors. The spread form also remains authorable against official Pi types without a new registration method; hosts that do not implement the metadata retain their ordinary exposure.

- `group.name`: a lowercase identifier matching `[a-z][a-z0-9_-]*`.
- `group.description`: a recognizable capability description, 1–240 characters.
- `group.sections`: optional custom prompt-section names. Every tool using a group name must agree on its description and section set. Duplicate or invalid section names and core prompt sections are rejected.
- `role: "entry"`: activates when the model enables the group.
- `role: "advanced"`: belongs to the group but remains behind the extension's own activation workflow.

Tools without metadata retain ordinary exposure. Built-ins are never deferred. Keep always-needed recovery/control tools ordinary, or explicitly activate permitted tools when recovery requires them. Metadata is host-only: it is not added to provider tool schemas. `getAllTools()` exposes it for host-side inspection.

Pi collects exact namespace/name identities from the final permitted registry. New registrations automatically join their declared group; removed, replaced, or excluded definitions cannot leave stale catalog members. A group with no permitted entry tool is omitted and its remaining tools keep ordinary exposure rather than becoming unreachable. Shared sections render when any owning group member is active.

## Host eligibility and restrictions

Deferral requires a known native API and the current model's explicit support for both tool additions and mid-conversation system messages:

| Native API | Required tool capability |
|---|---|
| OpenAI Responses, Codex Responses, Azure Responses | `supportsAdditionalTools` or `supportsToolSearch` |
| Anthropic Messages | `supportsMidConvoToolChanges` |
| OpenAI Completions | `supportsMidConvoToolAdditions` |

All also require `supportsMidConvoSystemMessages`. Unknown/custom APIs, including `cursor-sdk`, retain ordinary exposure even if their models copy these flags. This policy uses existing native model metadata, not a user-maintained provider catalog.

Explicit CLI/SDK tool allowlists bypass automatic deferral. Excluding `discover_tools` also disables deferral, rather than stranding capabilities behind an excluded loader. Tool exclusions remain binding. Extension lifecycle and recovery hooks continue to run. The ordinary integration loader is independent of MCP's native `tool_search` callback.

## Full instructions before first use

Pi populates `event.systemPromptOptions.sectionTools` before `before_agent_start`. An extension must generate its complete section text when its ownership key is present, even for a generic prompt and while its tools are inactive:

```typescript
pi.on("before_agent_start", (event) => {
  if (event.systemPromptOptions.sectionTools.browser_manual || needsBrowser(event.prompt)) {
    event.systemPromptOptions.sections.browser_manual = fullBrowserInstructions;
  }
});
```

Pi retains that hidden source text in the run's prompt options and reveals it after discovery, before the first integration call in the same run. Do not rely only on user-prompt keywords or current tool activity to generate it. Tool `promptGuidelines` and `promptSnippet` are already active-only. Unrelated instructions remain visible. Forced full-prompt replacements are opaque and unchanged.

## Selection and lifecycle

Activation is additive and idempotent; there is no per-turn unloading or separate selection journal. Pi's existing declaration history owns activation across resume, tree navigation, compaction, and fresh context windows. Navigating to a branch with saved declarations restores its selection. A target before the first declaration retains current selection and pending prompt edits, including lifecycle-hook activations. Checkpoint restoration applies its exact selection after startup hooks. Reload does not implicitly enable undiscovered groups.

Switching to an unsupported model restores group entry tools, not advanced tools, only while the discovery loader remains selected. Deliberate empty selections and selections that removed the loader are not widened. Returning to a supported model does not unload tools already made available; the loader returns only if it cannot expose previously deselected entry tools. Start a fresh session for a clean lean baseline.

Removing an extension's discovery metadata restores ordinary exposure. Native system declaration snapshots retain host-only, source-derived entry identities alongside the selected tools; they are not sent to providers. On resume, if the saved loader is selected, only recorded former entries that are permitted and no longer deferred return to ordinary exposure. Ordinary tools deliberately omitted even before their first declaration stay omitted, as do advanced or moved tools still deferred by current registrations. Snapshot updates follow the same branch, compaction, and fresh-window history as tool declarations; checkpoint restoration still applies its exact saved selection.

Historical declarations without this annotation cannot distinguish former entries from ordinary tools deliberately omitted. If a loader survives, Pi preserves their exact selection rather than guessing membership; a retired entry may therefore require explicit activation or a fresh session. If no eligible loader remains, unannotated history retains the older broad extension-exposure fallback, without reactivating deselected built-ins. Annotated snapshots use the narrower recorded-entry restoration in both cases.

`/reload` refreshes resources and reinitializes cached factories; changed extension/runtime code requires a process restart. Use normal package installations, not external staging paths.

## Verification

Before shipping metadata, verify initial exposure, generic-prompt discovery followed immediately by execution, complete instructions, restrictions, guards, late registration, reload/resume, branching, checkpoints, and pending-job recovery. Scripted offline tests establish these runtime contracts, not a model's ability to choose the right integration.

Measure first-request input, request count, cumulative input, and cache usage separately. First-use discovery costs a model round; cache support does not guarantee a cache hit. Compare representative task outcomes with the same model, thinking level, context, and skills. Do not claim zero quality regression from token counts alone.
