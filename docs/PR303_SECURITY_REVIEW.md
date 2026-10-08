# PR #303 independent security review

Reviewed the authority implementation at `9c820ca` and the subsequent local
Stripe qualification changes. This is independent agent review, not external
human certification, production qualification or real Stripe effect evidence.

## Verified finding and fix

The qualification helper could report successful recovery/replay when the kernel
returned a cached CONFIRMED receipt but the independent provider listing showed
the same refund ID with a pending status, different amount/currency or wrong
effect hash. It checked the refund count and ID without validating the exact
terminal provider receipt. A credential-free reproduction returned
`TESTED_RECOVERY_ONLY` for a pending GBP 999 refund and the wrong effect hash.

The profile now exposes its exact terminal receipt validator. Qualification
validates the independently listed effect and compares that receipt with the
kernel result before reporting success. Regression cases alter status, amount,
currency and effect hash after CONFIRMED is durable; qualification must reject
without another refund POST.

## Canonicalization and authority assessment

The [CrewAI #5802 canonicalization finding](https://github.com/crewAIInc/crewAI/issues/5802#issuecomment-6054615285)
concerns a separate signed-receipt reference implementation. Its plain-object
reconstruction drops an own `__proto__` key and its subsequent enumeration sorts
integer keys numerically. Once directly serializes sorted key/value pairs and
uses own-property definition for snapshots. Neither defect reproduced here.

Four added regressions pin lexical integer-key order, distinct hostile-key
fingerprints, root/nested/array effect and receipt preservation, durable replay
and changed-target CONFLICT. Independent local fixture journals retain one effect.

Source review covered authority-row locking, exact owner/lease checks,
witness-before-commit advancement, lost/late witness acknowledgement, commit
ambiguity, expired claims, reconciliation races and recovery. No additional
verified core blocker was found. Claims are never reassigned after expiry;
uncertainty blocks dispatch. Pool identity checks do not prove physical restore
independence, and cooperative fencing cannot revoke an issued provider request.

Stripe review also checked fresh versus existing-history qualification, provider
effects without retained history, remaining refundable balance before dispatch,
reconciliation after a fully refunded charge, test-key/parent-payment binding,
fixed provider origin, native idempotency, allowlisted diagnostics and bounded
provider/database requests. The Refund object has no `livemode` attribute;
the profile checks the test key and parent PaymentIntent/charge test-mode fields.
See the [Stripe Refund object](https://docs.stripe.com/api/refunds/object).

## Executed checks

- SDK ESM/CommonJS build passed.
- 61 relevant kernel, local, tool-call and adversarial tests passed; zero skips.
- The canonical security regressions and installed-driver verified-TLS test
  passed together: five tests, zero skips.
- An independent targeted run against disposable loopback PostgreSQL 18.4 passed
  all six Stripe profile/TLS tests, including the four newly pinned final-truth
  mismatches; zero skips. Broader shared-authority validation is recorded by the
  infrastructure reviewer. Local fixtures are not real-provider proof.

Physical-host separation, independently administered durable witness recovery
and a specifically authorized real Stripe sandbox run remain qualification gates.
No merge, publication, deployment or provider mutation was performed by this review.
