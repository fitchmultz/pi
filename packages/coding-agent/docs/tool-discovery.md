# Experimental tool discovery

Tool discovery reduces unused integration declarations without disabling extensions or shortening their instructions. It is opt-in and limited to explicitly selected providers. The model keeps ordinary coding tools and sees one small `discover_tools` catalog for the configured groups.

For example, a dependency audit need not receive browser schemas. A browser task calls `discover_tools({ enable: ["browser"] })`; Pi activates the group's normal entry tools and includes their complete schemas, guidelines, and associated prompt sections on the next request. Discovery executes no browser action. Actual calls still use normal validation, tool hooks, approvals, cancellation, and rendering.

## Configuration

Add a `toolDiscovery` object to [settings](settings.md#tools):

```json
{
  "toolDiscovery": {
    "enabled": true,
    "providers": ["openai-codex"],
    "groups": [
      {
        "name": "browser",
        "description": "Browse, search, interact with web pages, and verify browser UI",
        "tools": ["agent_browser", "agent_browser_code", "agent_browser_tools", "agent_browser_qa"],
        "defaultTools": ["agent_browser", "agent_browser_code", "agent_browser_tools"],
        "sections": ["agent_browser"]
      }
    ]
  }
}
```

This is an illustrative group, not a complete inventory for every browser extension release. Inspect the installed extension's tools when creating a profile. A conservative profile for the integrations used in this fork is provided in [tool-discovery.example.json](tool-discovery.example.json).

- `enabled`: defaults to `false`.
- `providers`: exact provider IDs evaluated for this rollout; required when enabled. Other providers retain ordinary tool exposure. Do not include Cursor: its current MCP bridge snapshots the catalog for an SDK run and does not implement this activation boundary.
- `groups`: at most 32 explicit capability groups. Keep each description short and recognizable by task, not just package name.
- `tools`: exact tool names, or `{ "namespace": "...", "name": "..." }` references. These tools start inactive. Built-in tools cannot be deferred through this setting.
- `defaultTools`: the group's normal entry tools to activate; defaults to `tools`. Leave advanced tools behind the integration's existing loader instead of loading every schema at once.
- `sections`: custom prompt-section names owned by the group. Their complete text renders when any group member is active. Shared sections remain visible if any owner is active. Core rules, project instructions, skills, and other core sections cannot be deferred this way.

Groups are filtered through the permitted registry. Missing/excluded tools are not made available by discovery. Explicit CLI/SDK tool allowlists retain their existing semantics and bypass automatic deferral. Excluding `discover_tools` also disables deferral, rather than stranding tools behind an excluded loader. Extensions may explicitly activate tools for automatic recovery or commands; discovery does not fight that selection.

## Lifecycle and rollback

Activation is additive and idempotent; there is no per-turn unloading. Pi's existing declaration history owns activation across resume, tree navigation, compaction, and fresh context windows. Navigating to a branch with saved declarations restores its selection. A target before the first declaration retains the current selection and pending prompt edits, including lifecycle-hook activations, just as ordinary Pi does. Reload does not implicitly enable undiscovered groups. Unlisted new tools retain their original startup behavior.

Switching to an unevaluated provider restores the groups' normal entry tools, not their advanced tools, only while the discovery loader remains selected. Deliberate empty selections and selections that removed the loader are not widened by that restoration. Returning to an evaluated provider does not unload tools already made available in that session. It re-adds the discovery catalog only if doing so cannot expose previously deselected entry tools; repeated provider switches preserve restricted selections. Start a fresh session for a clean lean baseline.

To roll back, set `toolDiscovery.enabled` to `false` and run `/reload`, or restart. This restores ordinary extension exposure without reactivating built-in tools deselected in the transcript. Keep the previous runtime and extension checkouts when trying a staged build. `/reload` alone does not load changed extension or runtime code.

## Instruction contract

Tool `promptGuidelines` and `promptSnippet` are already active-only. For dynamic custom sections, `BuildSystemPromptOptions.sectionTools` associates section names with tool references. The source section text remains in the run's prompt options even while omitted from model input, so activation can deliver it before the first tool call in the same run. Only custom sections are affected. Forced full-prompt replacements remain opaque and unchanged.

An integration whose hook declines to generate its instructions while inactive needs adjustment before deferral. Do not defer a background-control tool solely because the current user prompt does not mention it. Model discovery is not an adequate replacement for automatic recovery behavior.

## Quality gate

The example keeps editing replacements, working-directory support, questions, naming, subagent controls, intercom, goals, Posthorse recovery, and MCP's existing native discovery available. It defers only browser, native macOS, Oracle submission/authentication, and Z.ai lookups. Oracle read/cancel stay available for existing jobs. No provider, skill, project context, execution safeguard, or background handler is disabled.

Before promoting a profile:

1. Verify initial schemas and instructions, then discovery followed immediately by execution.
2. Verify restrictions, guards, late registration, reload/resume, tree navigation, and recovery.
3. Compare representative task outcomes with the same model, thinking level, context, and skills. Scripted/faux-provider tests verify plumbing, not the model's ability to choose the right integration.
4. Measure first-request input, request count, cumulative input, and cache usage separately. First-use discovery costs a model round and some providers rebuild their cached prefix when tools change.
5. Keep an integration eager if discovery causes missed capabilities or worse outcomes. Do not claim zero quality regression from token counts alone.
