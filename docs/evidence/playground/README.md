# Once Playground production evidence

## Production proof — 2026-09-22

A customer-facing production Sandbox Playground run successfully demonstrated
Once reconciling an ambiguous side-effecting execution without duplicating the
external effect.

### Environment

- Playground: https://playground.onceexec.com/
- Playground Worker: https://once-sandbox-playground.pennywatch.workers.dev
- Demo provider Worker: https://once-sandbox-demo-provider.pennywatch.workers.dev
- Git merge commit: `98bc1e46457c359c7ab5d0d638b2c2527c108c70`
- Playground Worker version: `f08e7351-8673-4aa2-a48c-984884749696`
- Demo provider Worker version: `0f55049d-505b-4e98-9fb5-05526abaac7a`
- Environment: production infrastructure using the Stripe sandbox/test flow

### Observed customer-facing result

Operation:

`demo:434ab119ab8b49f683b7503946be3f44`

Observed result:

- Once state: `CONFIRMED`
- Execution attempts: `2`
- Actual side effects: `1`
- UI result: `Duplicate side effect prevented`
- UI status: `Once reconciled the ambiguous execution.`

The production Playground showed the intended sequence:

1. provider performs the side effect
2. response becomes ambiguous
3. the same stable operation retries
4. provider truth confirms the external effect remains one

This demonstrates the production Playground path preserving one actual side
effect across an ambiguous retry.

## Scope

This evidence records one directly observed successful production Sandbox
Playground run. It is not intended to claim exhaustive coverage of every
provider, transport failure, or retry scenario.

The machine-readable record for this run is stored beside this file as
`production-proof-2026-09-22.json`.