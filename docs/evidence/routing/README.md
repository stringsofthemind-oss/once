# Once Agent Routing Conformance Evidence

## Result

Across six blind routing-conformance runs using two fixed suites:

| Suite | Gemini | Claude | Grok | Total |
|---|---:|---:|---:|---:|
| V1 | 17/17 | 17/17 | 17/17 | 51/51 |
| V2 adversarial | 40/40 | 40/40 | 40/40 | 120/120 |
| Combined | 57/57 | 57/57 | 57/57 | 171/171 |

Observed across the six runs:

- Over-routes: 0
- Under-routes: 0
- Invalid routes: 0
- Action mismatches: 0
- Runtime-state mismatches: 0
- Missing decisions: 0
- Unexpected decisions: 0
- Duplicate decisions: 0

## What was tested

The tests evaluated whether models could apply the Once execution-safety routing contract.

Once is evaluated only when all four conditions hold:

1. The operation can change external state.
2. The same logical operation may be retried.
3. The first attempt can have an ambiguous outcome.
4. Blind duplicate execution would be undesirable or costly.

The suites also tested runtime handling for:

- ABSENT -> EXECUTE
- CONFIRMED -> REPLAY_OR_SUPPRESS
- UNKNOWN -> BLOCK_AND_RECONCILE

Freshness / has_changed behavior was explicitly outside the scope of the shipped execution-safety product.

## Method

Three model families were tested:

- Gemini
- Claude
- Grok

Each family received the same frozen model-facing bundle for the relevant suite.

The hidden answer keys were not included in the model-facing bundles.

V2 was preregistered before model testing. Mechanical validation found a preregistration count discrepancy: seven cases were tagged as three-of-four boundary cases while the preregistration stated six. A pre-test amendment documented the correction before any V2 model evaluation. No case text, route answer, action answer, or model-facing bundle was changed as part of that amendment.

## Integrity

V1 canonical blind bundle SHA-256:

08511DAA71D752A7DB0DCEB0B829FDAF36D7F1D50FBAE405BCE0D474B1CA40F6

V2 canonical blind bundle SHA-256:

50C2D6420F71915FA896D94F6F9568B95991C169AA93D5406C97F5F0B9507344

Combined evidence JSON SHA-256:

EB00002CE38A45F7EB827E97194A777CA82AE796FEFB121DC2E55B3F4C72BC86

Combined evidence CSV SHA-256:

752EFDE00344F7F5791FF6371440634EA99C5862AAA46FE31D3A2B01

## Controlled Codex routing study

A separate controlled Codex study records autonomous Once selection, the read-only over-routing regression that exposed the need for a pre-tool gate, and the post-gate positive/negative validation pair:

- [`codex-controlled-routing-v1.md`](./codex-controlled-routing-v1.md)
- [`codex-controlled-routing-v1.json`](./codex-controlled-routing-v1.json)

This Codex evidence uses a controlled startup-loaded routing catalog and is intentionally not presented as proof of default production Codex behavior.

## Interpretation

These results demonstrate perfect conformance on these fixed suites in these six blind runs.

They do not establish universal model correctness, guarantee correct routing for every real-world operation, or constitute a claim of universal exactly-once execution.
