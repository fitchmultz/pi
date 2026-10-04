---
description: simplify a completed workpackage
---

Review the completed workpackage and simplify its implementation without changing its intended behavior.

## Scope

- Focus on code added or affected by the workpackage and the nearby code needed to simplify it coherently.
- Do not perform unrelated cleanup.
- Read the affected files in full and understand the relevant invariants, call sites, tests, and public API before editing.
- Optimize for a direct, coherent, maintainable design—not the smallest diff.

## What to remove or simplify

- Remove abstractions that have no clear responsibility or do not reduce real complexity.
- Inline trivial helpers, wrappers, adapters, and pass-through layers when they obscure rather than clarify behavior.
- Remove duplicated logic and put shared behavior at the appropriate existing layer.
- Remove speculative flexibility, configuration, extension points, and generic machinery that have no current requirement.
- Remove speculative defensive programming inside trusted code. Validate at real trust boundaries; rely on types and established invariants internally.
- Do not keep fallback behavior for states that should be impossible. Prefer fixing the invariant or type model.
- Simplify excessive state, boolean flags, branching, indirection, and special cases. Rework the underlying representation when that is clearer.
- Tighten TypeScript types so invalid states are unrepresentable. Avoid `any`, unnecessary assertions, broad types, and optional fields for impossible states.
- Prefer direct, readable code over cleverness, premature abstraction, and framework-like infrastructure.
- Delete comments that merely restate the code, but preserve comments that explain constraints, intent, or non-obvious decisions.

## Preserve the authorized outcome

The simplification request authorizes behavior-preserving refactors and deletion of redundant mechanisms, including deliberate abstractions when an equivalent simpler design covers their consumers. Trace callers, contracts and tests to establish equivalence; uncertain intent is a reason to investigate, not automatically to ask.

Preserve supported workflows, public contracts, persisted formats, security checks, validation and recovery guarantees. Existing task or standing authorization for a replacement counts; do not ask for it again. Ask only when completing the simplification requires an unapproved material behavior change or risks irreversible data loss. State the concrete consequence and continue independent authorized cleanup.

## Constraints

- Preserve intended behavior unless the current task or standing authorization already includes the change.
- Do not remove code merely because it is unused until you have checked whether it is a public API, extension point, generated entry point, or intentionally retained compatibility surface.
- Do not replace clear code with a new abstraction solely to reduce line count.
- Do not weaken tests to permit simplification. Update tests only when an approved behavior change or a cleaner equivalent structure requires it.
- Follow the repository's validation and testing instructions after edits.

## Completion

After editing, review the final diff for avoidable complexity, duplication, indirection, defensive branches, and accidental behavior changes. Report:

- what was simplified;
- which invariants the implementation now relies on;
- any unresolved material behavior decision and its concrete consequence; and
- the validation performed and its results.

Passing tests and type checks is necessary but not sufficient. Leave the affected code easier to understand and change.
