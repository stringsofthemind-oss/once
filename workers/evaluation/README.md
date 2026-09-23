# Once frictionless evaluation worker

This is an isolated experiment for reducing first-use friction without weakening the existing Once entitlement or API-key checks.

## Intended flow

When explicitly enabled by the operator:

1. an evaluator opens the evaluation Worker;
2. the Worker creates a one-day Stripe **test-mode** trial without showing Stripe Checkout or asking for a card;
3. the existing Stripe webhook records the normal Once entitlement;
4. the existing `SandboxClaim` path issues the normal sandbox API key;
5. the raw API key is shown once.

## Safety boundaries

- `EVALUATION_BYPASS_ENABLED` defaults to `false`.
- The Worker refuses Stripe keys that are not test-mode keys.
- No runtime entitlement check is bypassed.
- The existing Playground Worker is unchanged.
- No live Stripe payment is created by this experiment.
- The one-day trial is configured to cancel if there is no payment method at trial end.
- This Worker is not deployed or connected to the public website merely by existing in the repository.

## Before any public activation

Public anonymous access needs an explicit abuse-control decision. In particular, the current experiment uses the existing Pro sandbox entitlement, so it should not be exposed publicly until evaluation rate limits / admission controls are defined and tested.
