# Once frictionless evaluation worker

This is an isolated experiment for reducing first-use friction without weakening the existing Once entitlement or API-key checks.

## Intended flow

When explicitly enabled by the operator:

1. an evaluator opens the evaluation Worker;
2. the Worker applies admission controls before any Stripe object is created;
3. the Worker creates a one-day Stripe **test-mode** trial without showing Stripe Checkout or asking for a card;
4. the existing Stripe webhook records the normal Once entitlement;
5. the existing `SandboxClaim` path issues the normal sandbox API key;
6. the raw API key is shown once.

## Safety boundaries

- `EVALUATION_BYPASS_ENABLED` defaults to `false`.
- The Worker refuses Stripe keys that are not test-mode keys.
- No runtime entitlement check is bypassed.
- The existing Playground Worker is unchanged.
- No live Stripe payment is created by this experiment.
- The one-day trial is configured to cancel if there is no payment method at trial end.
- This Worker is not deployed or connected to the public website merely by existing in the repository.

## Admission controls

The evaluation Worker now uses its own `EvaluationAdmission` Durable Object before Stripe provisioning.

Initial defaults:

- maximum 3 new evaluations per pseudonymous client identity in a rolling 24-hour window;
- maximum 100 new evaluations globally in a rolling 24-hour window;
- retries using the same evaluation ID and same client identity do not consume another admission slot;
- an evaluation ID cannot be reused from a different client identity;
- evaluation admission expires after 24 hours;
- admission failures happen before Stripe customer/subscription creation;
- `Retry-After` is returned for rate/capacity limits;
- raw client IP addresses are not persisted by the admission object. The Worker HMACs the Cloudflare client address using `EVALUATION_ADMISSION_SECRET` before durable storage.

Required secret before enabling:

- `EVALUATION_ADMISSION_SECRET` — at least 32 characters, configured as a Worker secret rather than a repository variable.

Configurable limits:

- `EVALUATION_MAX_PER_CLIENT_24H` (default `3`)
- `EVALUATION_GLOBAL_MAX_24H` (default `100`)

If the admission binding, secret, or limits are invalid, activation fails closed.

## Remaining public-activation gate

The admission layer removes the anonymous unlimited-provisioning path, but public activation still requires an explicit operator decision and final review. The experiment currently uses the existing Pro sandbox entitlement for the one-day technical evaluation, so the public URL should remain disabled until the branch is reviewed, the admission secret is configured, the final CI pass is green, and the operator separately approves merge/deployment/routing.
