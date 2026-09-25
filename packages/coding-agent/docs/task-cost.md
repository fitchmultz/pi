# Task cost measurement

From a source checkout, run:

```sh
node scripts/task-cost.mjs task-manifest.json > task-cost.json
```

This offline report reads journals without opening sessions, loading credentials, or calling models. Define tasks explicitly; a final assistant message is not evidence of success.

```json
{
  "tasks": [
    {
      "id": "fix-refresh",
      "outcome": "completed",
      "evidence": "PR URL, passing regression check and review result",
      "sessions": ["sessions/root.jsonl", "sessions/continuation.jsonl"]
    },
    {
      "id": "unfinished-investigation",
      "outcome": "unknown",
      "sessions": ["sessions/investigation.jsonl"]
    }
  ]
}
```

Paths are relative to the manifest. Outcomes are `completed`, `failed`, or `unknown`. Include follow-ups, retries and unsuccessful attempts. The estimated cost per completion divides **all listed task costs** by the number of evidenced completions; unresolved outcomes make this provisional. Do not compare a curated successful sample with an unfiltered treatment cohort.

## Accounting

The report separates uncached input, cache writes, cache reads and output, with recorded USD estimates by model and work source. Reasoning is already included in output. Every journal branch is counted because abandoned work still costs money. Execution checkpoints are excluded. Usage entries require stable journal IDs; migrate older ID-less journals with Pi before analysis. Copied entries and native subagent contributions are deduplicated; conflicting usage rejects the report. A shared usage record assigned to different tasks also rejects it.

Use parent journals containing the subagent extension's native `usage` contributions. They include finalized worker usage, including nested work, without adding raw child totals again. `sessions` contains root/continuation journals only. Put raw descendants in optional `supplementalSessions`, including **every intermediate worker journal** between the root and deepest descendant. The reporter follows recorded contribution links and rejects unlinked supplements. A parent rollup can name an intermediate worker's usage entry, so root plus grandchild alone cannot establish whether they describe the same call. Do not evade this check by listing descendants as roots. Matching native contributions are deduplicated. Missing or unfinished worker contributions, legacy aggregate tool usage without contribution identity, and usage absent from failed provider calls require reconciliation outside this report. If only a continuation journal is available, copied history still represents incurred work; include the original journal to account for abandoned branches too.

`directResponses` counts directly observed assistant responses not represented by a subagent rollup, including errors and aborts. With root-only journals this is the parent; supplying child journals without rollups also adds their responses to this bucket. Imported usage records are **not** asserted to be worker call counts: they can include summaries or nested contributions. Transport counters and adapter latency are available only where recorded. They do not measure complete task latency or unreported provider retries. Malformed journal lines and missing costs remain visible gaps. The `journal` counters are raw per-file observations, not deduplicated lifecycle-event totals.

## Prices and actual billing

`usage.cost` is a historical estimate using the model metadata and service tier available when the call ran. It is not an invoice. Verify provider prices, cache-write TTL rates, whole-request long-context tiers, returned service tier, and price overrides before comparing cohorts. A high cache-read percentage does not establish low cost.

Codex subscription/credit usage is a different billing surface from OpenAI API dollars. Do not interpret its catalog-priced estimate as a dollar debit or assume that the API cache-write and Fast multipliers apply to Codex credits.

Optional task fields:

- `additionalCharges`: an array of `{ "kind": "search", "usd": 0.01, "evidence": "usage export reference" }`. These are added to estimated token cost and remain separately reported. Include material search, hosted-tool, gateway and external-review charges; do not charge local tools at similarly named hosted-tool rates.
- `actualBilledUsd` and `billingEvidence`: an independently reconciled task total and its receipt. The amount must already include additional charges. Actual cost per completion remains null until all tasks have billing evidence and no unknown outcomes.

The reporter does not silently reprice old journals, guess subscription allocation, classify tool failures as expected, or infer quality from model text. Per-source prompt bytes require provider diagnostics or an offline rendered-request capture; billing tokens cannot be allocated exactly to individual prompt sections from aggregate usage alone.

## Comparisons

Use the same task distribution and outcome criteria for control and treatment. Track correctness, review survival, user corrections, unexpected tool failures, model calls, retries, total task latency, cache reads/writes and full parent-plus-worker cost. Preserve model, reasoning and routing policy while evaluating context changes. A byte reduction is a candidate saving, not a measured task-cost improvement.
