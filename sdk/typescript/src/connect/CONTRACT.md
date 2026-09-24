# Once Connect V1

Once Connect is the framework-neutral protection boundary between
agent/tool execution and the existing Once execution-safety kernel.

Connect does NOT implement a second execution engine.

The existing Once kernel remains authoritative for:

- durable logical-operation state
- execution
- replay
- reconciliation
- CONFIRMED / ABSENT / UNKNOWN semantics

Connect is responsible for deciding whether a proposed agent tool call
must cross that safety boundary.

## V1 invariant

Connect must never convert uncertainty into permission.

## Routing contract

A tool call requires Once protection when all four conditions hold:

1. the operation can change external state;
2. the same logical operation may be retried;
3. the first attempt can have an ambiguous outcome;
4. duplicate execution would be undesirable or costly.

Reads, searches, retrieval, and generation-only operations normally
bypass Connect protection.

## Protected execution

For protected operations Connect must:

1. require stable logical-operation identity;
2. bind that identity to the consequential payload;
3. route execution through the existing Once kernel;
4. preserve existing CONFIRMED / ABSENT / UNKNOWN behavior;
5. fail closed when safe execution cannot be established.

Framework adapters must not independently reimplement these semantics.
