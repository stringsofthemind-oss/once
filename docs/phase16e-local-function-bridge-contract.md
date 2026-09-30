# Phase 16E — local-function protection bridge contract

Status: design/baseline only. This document does not authorize any production rewrite.

## Evidence that selects this work

Cold User #3 installed the public `@once-agent/sdk@0.1.16`, created a disposable local order operation, and reached `ADAPTER_REQUIRED`. Once discovered the consequential order call but did not provide a direct path from that discovered local function to the already-published `protectLocal` primitive.

The first Phase 16E slice therefore closes only that observed bridge gap. It does not broaden hosted provider semantics and it does not weaken the existing fail-closed boundary.

## V1 target

V1 may eventually make one explicitly selected local order function eligible for a deterministic `protectLocal` source patch.

The initial source contract is deliberately narrow:

- source file is explicit ESM `.mjs`;
- target is a top-level exported `const` initialized to an `async` arrow function;
- the function has exactly one object-destructured parameter;
- destructured entries are simple identifiers only;
- no defaults, rest elements, aliases, nested patterns, computed names, or extra parameters;
- the arrow has an expression body containing one direct member-call expression, such as `provider.createOrder(...)`;
- the selected call is classified as `BOOKING` / order mutation by the existing scanner;
- the exact selected top-level binding is established from parsed source structure, not merely from the scanner's nearby `function_name` text;
- the original callee and call arguments are preserved exactly inside the protected operation;
- every destructured input field is included in the local payload in V1.

A provider object or another nested method may use the same method name. That does not authorize rewriting it. The bridge targets only the exact top-level exported binding selected by the user and proven by the source contract.

## Identity is never inferred

Detection of a field such as `orderId` is not permission to use it as logical operation identity.

Before any source patch can become eligible, the user must explicitly supply both:

- a non-empty literal identity prefix, for example `create-order`;
- one simple destructured field that is the stable identity of the intentional real-world action, for example `orderId`.

A future CLI may expose this as a command shaped like:

```text
once protect-local orders.mjs:createOrder --id-prefix create-order --id-field orderId
```

The exact CLI spelling is not yet a compatibility promise. The safety rule is the contract: no identity declaration means no patchable result.

The generated identity would be equivalent to `create-order:${orderId}`. A retry of the same intentional action must reuse the same field value. A different intentional action must use a different value.

## Payload rule

V1 includes every simple destructured input field in `payload`. It does not guess that an input is transport-only and it does not allow the user to silently omit a field that may change the external effect.

Functions with transport-only inputs or values that should not participate in the effect fingerprint remain outside V1 until a separate explicit contract is proven.

## Runtime boundary

The bridge uses the existing `protectLocal` runtime semantics. Therefore:

- Node.js 24.15+ is required;
- durable SQLite state is same-machine only;
- every consequential call must route through the wrapped function;
- direct calls to the underlying provider bypass the boundary;
- internal provider retries or multiple downstream effects inside one invocation are not converted into separate Once-protected actions;
- a resolved result must represent a confirmed outcome;
- ambiguous outcomes remain blocked;
- V1 does not generate a reconciliation callback automatically;
- V1 does not redispatch after an ambiguous local attempt.

This is not a multi-host or universal exactly-once guarantee.

## Future patch invariants

Any implementation following this contract must prove all of the following before `auto_apply_eligible` can become true:

1. exact source file and top-level binding identified structurally;
2. exact V1 source shape accepted;
3. category is the pinned local `BOOKING`/order slice;
4. explicit identity prefix and identity field supplied by the user;
5. identity field is one of the destructured input identifiers;
6. every destructured input identifier is included in the payload selector;
7. original member call and its arguments are preserved inside `protectLocal`;
8. caller-visible exported binding and call shape are preserved;
9. import/binding insertion is collision-safe;
10. proposed source parses successfully before disk mutation;
11. source fingerprint still matches immediately before apply;
12. exact original source is backed up;
13. replacement is atomic and verified after write;
14. any ambiguity or unsupported syntax fails closed with source unchanged.

## Intentionally unsupported in V1

- plain `.js`, `.cjs`, JSX, or ambiguous module mode;
- TypeScript source;
- function declarations;
- block-bodied arrows;
- more than one parameter;
- defaults, rest, aliases, nested destructuring, computed fields;
- dynamic selection of identity;
- inferred identity prefixes;
- user-selected partial payloads;
- multiple consequential calls in the selected function;
- non-BOOKING categories;
- remote/multi-host state coordination;
- automatic reconciliation generation;
- any change to `UNKNOWN` handling.

## Baseline benchmark

`sdk/typescript/scripts/local-function-bridge-coverage.mjs` freezes representative current behavior before the bridge exists.

The benchmark records two separate facts:

- `contract_intended`: source shapes this V1 design intends to support later;
- current Protect behavior: what the product actually reports now.

At this baseline, all contract-intended local order fixtures must remain non-patchable and no fixture may become auto-apply eligible. A future implementation must update the benchmark only together with the deterministic transformer/patch proof that justifies the changed result.

Coverage from this benchmark is a source-surface measurement, not an accuracy percentage.