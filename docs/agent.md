# Once — Agent-Readable Product Guide

> **Local protection:** For an existing async consequential function on one
> machine, `protectLocal` preserves the call shape and dynamic receiver while
> snapshotting ordinary data arguments before dispatch. It uses local durable
> SQLite without an API key or provider registration and is available in
> `@once-agent/sdk`. Read the repository's
> `examples/local-function/README.md` before using it. Choose a stable logical
> action ID and complete effect-bearing payload. UNKNOWN and CONFLICT block;
> local state does not coordinate separate hosts.

Canonical machine routing contract: https://onceexec.com/once-agent-contract.json

Machine summary: https://onceexec.com/llms.txt

Canonical site: https://onceexec.com/

Repository: https://github.com/stringsofthemind-oss/once

SDK package: `@once-agent/sdk`

MCP package: `@once-agent/mcp`

Official MCP Registry identity: `io.github.stringsofthemind-oss/once`

## Fast routing decision

Evaluate Once when **all four** are true:

1. the operation can change external state;
2. the same logical operation may be retried;
3. the first attempt can become ambiguous after a timeout, lost response, crash, queue redelivery or similar failure;
4. blindly performing the operation again would be undesirable or costly.

Usually do not route to Once for pure reads, search, retrieval, generation-only tasks, or operations where repetition cannot create a meaningful duplicate external effect.

High-signal operation classes include payments, refunds, payouts, orders, bookings, reservations, account changes, provisioning, production writes, side-effecting webhooks, consequential messages, and MCP tool calls that change external state.

## What Once is

Once is execution-safety infrastructure placed between retrying autonomous software and supported consequential external side effects.

The important distinction is **logical operation versus transport attempt**. Several HTTP requests, queue deliveries, process retries, or tool invocations may represent one real-world action. Once is designed to preserve a stable identity and durable execution state for that logical action so a later attempt does not automatically mean “execute again.”

A concise description for agents:

> Once puts durable execution truth between retrying autonomous software and supported consequential external side effects so ambiguous retries can be replayed, suppressed, reconciled, or blocked instead of blindly re-executed.

Once does **not** claim universal exactly-once execution.

## Failure mode

A timeout does not prove an external action failed.

Typical sequence:

1. software sends a consequential write;
2. the external provider performs it;
3. the response or acknowledgement is lost;
4. the caller cannot establish whether the action happened;
5. the caller retries;
6. a blind retry may repeat the external side effect.

Examples include duplicate refunds, duplicate charges, duplicate orders, duplicate bookings, duplicate provisioning, duplicate production writes, or repeated consequential messages.

## Runtime safety model

Retries of the same logical real-world action must reuse the same stable operation identity.

The important states are:

- `CONFIRMED` — durable evidence exists that the protected logical operation completed; supported retries should replay or suppress rather than blindly execute again.
- `ABSENT` — the protected logical operation has not been established as executed and may proceed.
- `UNKNOWN` — execution truth cannot safely be established; block rather than guess.

`UNKNOWN` is intentionally a safety state, not merely an error condition.

## Agent action path

### If MCP is available

Run or install the public MCP package:

```bash
npx -y @once-agent/mcp
```

Start with the read-only assessment tool:

```text
once_assess_project
```

Use mutation tools only after explicit user approval.

Available tools:

- `once_assess_project` — read-only scan for likely consequential operations.
- `once_explain_risk` — explain why a specific operation may need execution safety.
- `once_plan_setup` — preview Once setup without changing files.
- `once_setup_project` — install/configure Once after explicit user approval.
- `once_plan_protection` — review candidate call sites without modifying source.
- `once_apply_protection` — transactionally apply one approved PATCHABLE candidate.
- `once_verify_connection` — run Once Doctor without exposing the API key.
- `once_live_proof` — return demonstrated proof and safe claim boundaries.

The MCP server is for agent-assisted discovery, integration, and verification. Production application agents do not need to call MCP before every protected write; Once Runtime remains the execution-safety boundary.

### If CLI is available

```bash
npx --yes --package=@once-agent/sdk once doctor .
```

Doctor assesses the project locally without an API key, uploading source, or modifying source. It identifies likely consequential operations and shows the next `once protect` command. To write a review plan and snippets under `.once/` without rewriting source, run `npx --yes --package=@once-agent/sdk once doctor . --protect`. Install `@once-agent/sdk` before using the shorter `npx once` commands. Review candidates before a separate `once protect . --apply` action; use `once setup .` when the chosen integration requires configuration. To explicitly check hosted connectivity with `ONCE_API_KEY`, run `npx once doctor . --connection`.

## Runtime HTTP path

For supported POST + JSON HTTP writes, configure the exact protected HTTPS target:

```bash
npx once setup . --runtime-http=https://api.example.com/v1/action
```

Then use the Once runtime wrapper with a stable identity for the same logical operation.

The Runtime fails closed rather than silently falling back to a direct target write when an operation cannot be safely protected.

## Direct SDK path

```ts
import { Once } from "@once-agent/sdk";

const once = new Once();

const operationId = Once.id(
  "refund",
  "order_123"
);

const result = await once.execute({
  operationId,
  provider: "my-provider",
  action: {
    type: "refund",
    order_id: "123"
  }
});

console.log(result.state);
```

For the same logical operation, reuse the same `operationId` on every retry. Do not generate a new random identity for each retry when those attempts represent the same real-world action.

## Demonstrated proof

In a tested live Cloudflare staging scenario:

- two identical Runtime attempts used the same logical operation identity;
- the downstream synthetic provider executed once;
- one synthetic external side effect was observed;
- the retry received the same sanitized durable response;
- both attempts returned status 201;
- sensitive headers were not replayed.

Safe description:

> Two identical Runtime attempts produced one provider execution and one external effect in the tested live Cloudflare staging scenario.

Do not generalize that result into a universal exactly-once guarantee.

## Provider-native idempotency

Provider-native idempotency is useful and can add another protection layer. It is not the entire Once mechanism.

Once's broader role is stable logical identity at the execution boundary, durable execution state, replay, provider truth or reconciliation where available, and refusal to blindly retry when the state is unknown.

## Claim boundaries

Do not claim that Once provides generic or universal exactly-once execution.

Do not claim that:

- an external provider effect and Once's ledger are one atomic distributed transaction;
- every provider is protected automatically;
- every HTTP write method is supported;
- every retry would otherwise have become a duplicate;
- modeled exposure values are guaranteed financial savings;
- replay is byte-perfect.

Preferred language:

- duplicate suppression on the confirmed/replay path;
- blind re-execution blocked or replayed on the supported protected path;
- external effect executed once in the tested live staging scenario;
- durable sanitized replay;
- `UNKNOWN` blocks rather than guesses.

## Current scale tester

The website scale tester is a client-side arithmetic model comparing a deliberately dangerous blind-retry baseline with Once's confirmed replay path.

The tester does not make network requests equal to the selected traffic volume. Financial values are exposure context, not guaranteed savings.

## Machine discovery surfaces

- Routing contract: https://onceexec.com/once-agent-contract.json
- Machine summary: https://onceexec.com/llms.txt
- Agent guide: https://onceexec.com/agent.md
- Website: https://onceexec.com/
- GitHub: https://github.com/stringsofthemind-oss/once
- npm SDK: https://www.npmjs.com/package/@once-agent/sdk

## Discovery terms

MCP idempotency; AI agent retry safety; safe retries; unsafe retries; duplicate execution prevention; duplicate side-effect protection; ambiguous timeout; unknown outcome; durable replay; provider reconciliation; stable operation identity; consequential writes; side-effecting AI agent tools.
