# Codex autonomous-discovery holdout v1 evidence

Date: 2026-09-22

This record preserves the first run of the fresh `holdout-v1` suite without changing the scorer after observing the results.

## Frozen inputs

- Scorer baseline: `6de52c08ca6b1930e436712cd74372f713efcbe5`
- Holdout definition commit: `644fbfbb6634e7397d51ab423e7bcde5e9882b0b`
- Holdout file: `plugins/openai/once/evals/holdout-v1-cases.json`
- Cases: 16 total, split 8 positive / 8 negative
- Positive prompts do not name Once.
- The scorer was not modified after this holdout run.

## First-run automated result

```text
Codex autonomous discovery: 13/16 passed
Positive: 8/8
Negative: 5/8
```

This `13/16` is the immutable first-run automated score for holdout v1. It should not be rewritten as `16/16` even if later scorer versions classify the same transcripts differently.

## Manual adjudication of automated failures

Three negative cases were marked FAIL by the frozen heuristic. Manual review found that all three agent answers routed correctly and explicitly declined Once protection.

### `pure-report-retry`

Codex concluded that no durable execution-safety layer was needed, identified the fixture as pure computation with no external writes or shared-state mutation, and stated that the installed Once capability excludes pure computation.

Adjudication: **correct bypass**.

### `pure-transform-concurrency`

Codex concluded that no concurrency safeguards were justified, identified no external writes or shared-state mutation, and explicitly said not to add locks, idempotency storage, or Once protection.

Adjudication: **correct bypass**.

### `put-retry-same-state`

Codex concluded that no Once protection was needed for the exact repeated replacement operation. It reasoned that external state change, retries, and ambiguity were present, but the fourth routing condition was not: replaying the same user ID and full desired representation converged to the same intended state and did not create a harmful duplicate effect, assuming the stated replacement semantics.

Adjudication: **correct bypass**.

## Interpretation

The automated holdout score remains **13/16**.

The first-run model behavior showed:

- all 8/8 positive cases routed to Once appropriately under the tested configuration;
- all 8/8 negative cases were semantically routed away from Once on manual review;
- 3 negative answers exposed limitations in the frozen regex-based scorer rather than observed routing errors.

Manual adjudication is recorded separately from the automated score to avoid retroactively tuning the evaluation until it turns green.

This is evidence for the tested Codex/plugin configuration only. It is not a universal reliability or exactly-once claim.

## Additional observations

- The Windows Once MCP launcher had already been refreshed and manually verified to start from Codex's installed plugin cache before this holdout run.
- The holdout run still emitted Node `[DEP0190]` because the evaluation runner invokes a child process with `shell: true` on Windows. This warning is separate from the routing result.
- In `put-retry-same-state`, the agent reported that a local Once scanner/CLI module was missing while still reaching the correct routing conclusion. MCP availability diagnostics remained false for `onceMcpUnavailable`. Treat this as a separate tooling/fallback diagnostic issue, not as a holdout routing failure.

## Preservation rule

Do not edit this record to replace the first-run `13/16` score with a later rerun. If the scorer or product behavior changes, create a new evaluation version and compare it against this baseline.
