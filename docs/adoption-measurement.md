# Measuring adoption without overstating evidence

Installation, download counts, scanner candidates, route-proof receipts and
controlled fixtures measure different things. None establishes independent
customer usage or production-provider safety.

## Opt-in onboarding records

Keep records locally by default. A participant may voluntarily share a redacted
record; no SDK telemetry endpoint or customer identifier is required. Freeze the
package versions, runtime, instructions and fixture before starting each cohort.

Record one row per attempted path, including failures:

| Field | Meaning |
| --- | --- |
| run_id | Random study-local identifier; no user/account identifier |
| evidence_tier | controlled-fixture, provider-sandbox, or voluntary-independent-reproduction |
| versions/runtime/platform | Exact installed packages and execution environment |
| path | TypeScript, Python, MCP, Claude Code, Codex, Agents SDK or ADK |
| start/installation/first-protected/recovery timestamps | Measure each phase separately; leave unobserved phases null |
| outcome | success, install-failure, adapter-required, unsupported, recovery-blocked or abandoned |
| interventions | Number of manual corrections or maintainer interventions |
| effect_counts | Separately observed initial, replay, changed-input and recovery effects |
| receipt | Redacted link to journal/test evidence, with its authority and limitations |

Never share secrets, payloads, account IDs, raw operation IDs or filesystem paths.
Publishing aggregate results is opt-in; report the sample size and all failures.
Calculate fresh-install success as successful attempts / all attempted installs,
and report adapter-required and unsupported outcomes separately. Time to first
protected action starts at the participant's first view of the frozen instructions,
not at CLI launch. Separate installation time, execution time and human integration
time. Recovery success requires independently observed provider truth and effect
counts, not only a returned success object.

## Existing local CLI metrics

`once` prints heuristic candidate/applicability counts and a current route-proof
receipt. Its elapsed time is CLI processing time. These diagnostics send no
telemetry; their labels do not establish a complete application/provider proof or
human onboarding duration. Do not combine these rates with actual installations,
independent reproductions, repeat usage or customer totals.

The FIRST 10 proof is a reproducible controlled loopback fixture. Keep its
provider journal and negative control alongside results. Its runtime can track
fixture regressions, but does not measure real-world user adoption. Hosted Python
execution, live model selection and installed Claude/Codex routing need separate
account/configuration and observed checks.
