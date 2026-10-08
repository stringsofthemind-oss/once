# Bounded Stripe sandbox refund qualification

This host-owned example uses the existing shared kernel and Stripe adapter with
native `once:<operationId>` idempotency retained. The runner fixes the effect to
USD 1 on one operator-designated, preexisting test PaymentIntent. It creates no
payment or charge. No universal exactly-once or production certification is claimed.

Build the SDK, then run `node examples/stripe-sandbox-refund/qualify.mjs` from the
SDK directory only after supplying the ten secure host bindings documented in
[PR303 readiness](../../../../docs/PR303_READINESS.md). Runtime never provisions
schemas/checkpoints or silently replaces an authority. PostgreSQL URLs require
verified TLS and reject query overrides; execution and witness clusters must have
independent failure and restore domains established by the operator.

Before any POST the profile verifies the authenticated account, succeeded USD
PaymentIntent with `livemode=false`, and exact latest captured, paid, undisputed
test charge. It requires integer `amount_captured - amount_refunded >= 100`.
Remaining balance is checked only before dispatch: a refund consuming the last
balance must remain reconcilable. This preflight is not an atomic reservation at
Stripe; unrelated operators must not concurrently refund the designated payment.

For a fresh proof, no execution row or operation-tagged provider refund may exist.
The callback performs one refund and authoritative exact readback, then deliberately
throws before the kernel can confirm it. A local counter proves this injection ran;
a replay cannot satisfy it. The runner reads committed UNKNOWN, closes/recreates
both pools and the authority, verifies UNKNOWN again, and simulates unavailable
reconciliation truth to assert another call blocks without a POST. It then uses
real authenticated Stripe listing to reconcile exactly one succeeded refund,
checks confirmed replay, changed amount CONFLICT, and one new refund in the full
before/after designated-payment listing. It also verifies recovery counters stayed
at zero. Provider effect records and local POST attempts are separate evidence.

A provider refund without retained execution history fails closed before dispatch.
Malformed, duplicated, unavailable or incomplete bounded pagination cannot confirm
truth. Absence never authorizes a second dispatch after UNKNOWN. Reconciliation
requires complete account/payment/amount/currency/operation/effect-hash binding.

Exit 0 means a fresh sandbox acknowledgement-loss path passed. Exit 2 means an
existing operation recovered/replayed successfully, but the fresh-loss gate remains
unsatisfied. Exit 1 means blocked/failed closed. Reruns always retain the original
identity; never rotate an ambiguous intent to manufacture a fresh result. A new
qualification intent needs explicit owner designation as a genuinely new refund.
The controlled identity uses 1–200 ASCII letters/digits or `. _ : -`, beginning
with a letter/digit. The JSON evidence retains allowlisted refund fields, stages,
state observations and local attempt counters; errors and credentials are omitted.
Keep the evidence in an access-controlled host directory (Windows ACLs remain
host-owned; POSIX file mode alone does not enforce Windows access).

Failure injection is a local exception after provider readback, not a real Stripe
network failure. Pool reconstruction tests new sessions/authority objects, not OS
worker termination. The independent container proof covers killed workers and
stale fencing with a simulated provider; real-provider worker termination,
witness/database outages and independent hosts remain separate qualification gates.
Native Stripe idempotency stays enabled, so evidence applies to this combined path
and does not isolate Once's contribution from the provider's deduplication.

The deterministic profile test uses real disposable PostgreSQL plus a simulated
Stripe journal and is local mechanics evidence only. Real Stripe qualification
remains BLOCKED until authorized bindings are available. Pending refunds, live
payments, other currencies/accounts and arbitrary connector interception are outside
this bounded profile.

Provider contract sources: [Charge object](https://docs.stripe.com/api/charges/object),
[PaymentIntent object](https://docs.stripe.com/api/payment_intents/object),
[Refund object](https://docs.stripe.com/api/refunds/object), and
[Refund listing](https://docs.stripe.com/api/refunds/list). Refund objects lack a
livemode field; test key plus authenticated parent test-mode admission establishes
the intended sandbox boundary.
