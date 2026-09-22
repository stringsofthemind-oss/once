# Codex autonomous-discovery evaluation

This suite tests the harder question: after the Once plugin is installed, will Codex recognize a retry-safety problem as a Once use case **without the user naming Once**?

The prompts deliberately avoid the product name. Positive cases describe consequential writes with retry + ambiguous outcome + duplicate risk. Negative controls describe reads or pure local work where Once should stay out of the way.

## Local run

Install/enable the plugin first:

```bash
codex plugin marketplace add stringsofthemind-oss/once --ref main
codex plugin add once@once-agent
```

Then, from the repository root:

```bash
node scripts/run-codex-autonomous-discovery.mjs
```

Run one case:

```bash
node scripts/run-codex-autonomous-discovery.mjs --case cross-agent-handoff
```

The runner uses `codex exec` in a read-only sandbox and retains raw JSON/transcript output for review. It never asks Codex to modify fixture files.

## CI/manual run

`.github/workflows/codex-autonomous-discovery.yml` is intentionally `workflow_dispatch` only. It performs a real Codex model-session evaluation when the repository has a `CODEX_API_KEY` Actions secret. The workflow installs the tested Codex CLI baseline, installs Once from the checked-out marketplace, runs all routing cases, and uploads the raw results artifact.

The credential is never written into the result file.

## Scoring boundary

The automated score is a heuristic, not a product reliability claim.

A positive case passes when the transcript autonomously identifies the Once capability and relevant ambiguity/retry risk without also saying Once should be bypassed. A negative case passes when Codex does not recommend adding Once, or explicitly explains that Once is unnecessary.

Always inspect the retained transcript before treating a run as evidence. Model behavior may vary by model/version, and a passing suite only applies to that tested configuration.
