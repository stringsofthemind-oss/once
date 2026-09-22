# Once routing cases for Codex

These cases are examples for deciding whether to evaluate Once. They are not claims that every operation in the named product category is unsafe by default.

## Positive cases — evaluate Once

### 1. Refund after ambiguous timeout

Prompt: "Our refund request can time out after the payment provider has already committed the refund. Make retries safe."

Why: external state changes; retry is possible; the first outcome can be ambiguous; duplicate refunding is undesirable.

### 2. Booking creation after lost response

Prompt: "If this booking API loses its response, the worker retries the same customer reservation. How do we stop a duplicate booking?"

Why: the booking is a consequential write and a lost response can hide a successful first attempt.

### 3. Infrastructure provisioning with queue redelivery

Prompt: "This job provisions a production resource and the queue may redeliver after the worker crashes. Protect it from doing the same provisioning twice."

Why: a crash/redelivery can replay a real-world action whose first outcome may already be durable.

### 4. Side-effecting MCP tool

Prompt: "This MCP tool sends a consequential customer message. The agent may retry after the tool connection drops. Audit the retry path."

Why: the MCP call changes external state and a transport failure can leave its result unknown.

### 5. Cross-agent handoff

Prompt: "Agent A may start a payout, disappear, and Agent B can pick up the same task hours later. Make the handoff safe."

Why: the logical payout outlives any one agent or session. Both agents need shared execution truth and the same stable operation identity.

## Negative cases — do not route to Once

### 1. Pure retrieval

Prompt: "Retry this search request if the documentation site returns 503."

Why not: retrieval does not create a consequential duplicate external effect.

### 2. Generation only

Prompt: "If the model call fails, regenerate the draft summary."

Why not: generation alone does not mutate external state.

### 3. Repetition is harmless

Prompt: "Retry reading the current feature flag until the service answers."

Why not: repeating the read cannot duplicate the external side effect Once is designed to protect.

## Identity test

For every positive case, ask:

> If a different process or agent retries this later, should it still represent the same real-world action?

If yes, the stable Once identity should be derived from semantic business identity such as an order, invoice, booking, payout, deployment, or message intent — not from the retry attempt, clock time, agent identity, or session.
