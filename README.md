# Once: your agent sent the refund. The response disappeared. Should it try again?

A provider can commit an action before the caller receives its response. Blind retry can refund twice. Once remembers one logical operation, replays confirmed results, and blocks another write while the original outcome is unknown.

## See it happen in under five minutes

Node.js **24.15+**. No account, API key, or financial transaction. The proof uses the published SDK and a controlled local HTTP provider with its own effect journal.

From this checkout:

```sh
npm install --no-save --package-lock=false @once-agent/sdk@0.1.25
node examples/first10/prove.mjs
```

```text
WITHOUT ONCE: acknowledgement lost; fresh-process retry -> 2 provider writes
CONFIRMED: 1 provider write; restart replay; changed £50 -> £80: CONFLICT, 0 additional writes
RETRY BLOCKED — ORIGINAL OUTCOME UNKNOWN
The refund may already have succeeded. Once sent no second request.
LOST-ACK: 1 provider write; UNKNOWN -> CONFIRMED; recovered refund_1
PASS
```

Every stage checks the separate provider's HTTP counter against its effect journal. Evidence is retained in the printed directory. This proves the controlled fixture, not a real payment provider. [Complete instructions, download path and recording recipe](examples/first10/README.md).

## Protect one of your own operations

Natural Placement: `wrapTool` replaces a host-owned async callback. You explicitly own identity and effect fields; no semantic decision is silently inferred.

```js
import { wrapTool } from "@once-agent/sdk";
const safeRefund = wrapTool(refundCustomer, {
  operationId: x => `${x.tenantId}:refund:${x.refundIntentId}`,
  effect: x => ({ tool: "payments:reviewed-account:refund", args: x }),
  statePath: "./durable/operations.sqlite",
  reconcile: lookupAuthoritativeRefund,
});
```

The callback and lookup are your reviewed provider functions. Inspect every argument, bind full account/tenant authority and all effect-bearing fields, and exclude Authorization credentials. Route every write through the wrapper. Internal callback retries remain outside the boundary. The lookup returns `{status: "CONFIRMED", result}` only from authoritative provider truth, otherwise `{status: "UNKNOWN"}`. If unsupported, omit reconciliation and UNKNOWN remains blocked.

Local SQLite requires a persistent shared file on **one machine**, Node 24.15+, and distinct IDs for genuine new intents. Multiple legitimate partial refunds need distinct refund-intent IDs. [Complete integration guide](examples/natural-placement/README.md).

The ledger is part of execution authority. Changing, deleting, replacing,
resetting, rolling back or switching valid ledgers may permit an effect to
execute again. The same filesystem path does not prove the same history.
Fresh provisioning is separate from restart; preserve the original consistent
SQLite state and do not reinitialize missing expected state. UNKNOWN blocking
does not repair lost history. See [MCP compatibility and continuity](mcp/COMPATIBILITY.md).


## When you need Once — and when you do not

Evaluate Once when a consequential external write may be retried, its outcome can become ambiguous, and another effect would matter. Refunds, bookings, messages and tickets are examples, not automatic provider support.

If a provider idempotency key completely solves your operation, use it. If a Postgres unique constraint completely solves it, use it. If repetition is harmless, you probably do not need Once. Keep native idempotency even with Once. Once does not replace your database, framework, queue, or Temporal and does not promise universal exactly-once execution.

**UNKNOWN is protection:** the original action may have succeeded. Retain its identity and durable state; perform an authoritative read-only lookup. Never mint a new ID or bypass Once to force progress. Even an absence observation does not automatically permit local redispatch.

## LangGraph checkpoint replay evidence

Deterministic **local LangGraph JS checkpoint replay** resumed the same checkpoint twice while the first tool call was still running. The unprotected path produced **2 provider effects**; the Once-protected path produced **1**, counted from a separate loopback HTTP provider's append-only log using published SDK 0.1.25.

**Limits:** this is not a LangGraph Cloud reproduction or a test of the reported ~180s sweeper. Protection used one persistent shared **same-machine SQLite authority**; separate ephemeral Cloud ledgers are outside this evidence. No universal exactly-once claim or Cloud bug fix is established.

[Run and inspect the reproduction](examples/langgraph-once-replay/) · [Merged proof PR #295](https://github.com/stringsofthemind-oss/once/pull/295) · [Volunteer for one bounded Cloud test](https://onceexec.com/evidence/#langgraph-cloud-test). Independent Cloud evidence is still sought; a local fixture PASS is not adoption.

## Find a candidate

SDK 0.1.25 includes read-only `once check [directory]` and `once prove` for the controlled refund fixture. Run `npx --yes --package=@once-agent/sdk@0.1.25 once prove` for the one-command proof. `once doctor` remains the detailed assessment path. Scan and installation do not activate protection; the fixture never executes your code.

[Website](https://onceexec.com/) · [Quickstart](https://onceexec.com/quickstart/) · [Evidence](https://onceexec.com/evidence/) · [FIRST 10 plan and ledger](docs/FIRST10.md)

---

## Deeper semantics, integrations, architecture and historical evidence

# @once-agent/sdk

> **Natural Placement (introduced in SDK 0.1.24):** `wrapTool(callback, semantics)` protects a
> host-owned tool callback using the existing local safety engine. Supply stable
> logical identity, complete effect/account binding and authoritative reconciliation.
> Requires Node.js 24.15+ and one durable same-machine SQLite authority; `UNKNOWN`
> blocks redispatch. Opaque callback retries and connector-only model access remain
> outside this boundary. See [the integration examples](./examples/natural-placement/README.md).

> **Automatic Connect:** `@once-agent/sdk@0.1.25` publishes the tested
> `@once-agent/sdk/connect` path for classifying supported agent tools as
> `BYPASS`, `PROTECT`, or fail-closed `UNKNOWN`, then wiring whole local tool
> registries with trusted logical identity and effect binding. It also includes
> direct OpenAI Agents FunctionTool wrapping. See
> [the automatic Connect guide](./docs/CONNECT_AUTO.md).

> **Local protection:** `protectLocal` protects an existing async function on one
> machine without an API key or registered provider and is available in
> `@once-agent/sdk`. See the
> [local function guide](./examples/local-function/README.md) for its exact
> safety boundary and a first effect-count check.

> **Start here:** [Run the ungated retry simulation](https://onceexec.com/demo/) or
> [verify your first protected action locally](https://onceexec.com/quickstart/).
> The simulation does not execute the SDK; the local guide uses the installed SDK
> and a controlled fake provider, including fresh-process and UNKNOWN checks.

## Once — AI Agent Execution Safety

**MCP idempotency and safe retries for consequential AI agent writes.**

Once helps protect supported refunds, bookings, payments and other externally visible side effects from unsafe duplicate execution after ambiguous timeouts, lost responses and retries.

- Website: https://onceexec.com/
- Automatic Connect guide: [`docs/CONNECT_AUTO.md`](./docs/CONNECT_AUTO.md)
- MCP idempotency guide: https://onceexec.com/mcp-idempotency/
- AI agent retry safety: https://onceexec.com/ai-agent-retry-safety/
- TypeScript SDK: [`@once-agent/sdk@0.1.25`](https://www.npmjs.com/package/@once-agent/sdk)
- Python SDK: [`once-agent-sdk==0.1.1`](https://pypi.org/project/once-agent-sdk/)
- MCP package: `@once-agent/mcp@0.2.0`

Existing OpenAI/Claude plugin launchers remain pinned to their previously reviewed MCP 0.1.5. This MCP release does not release a new plugin or enable the private experimental GitHub adapter.
- MCP Registry: `io.github.stringsofthemind-oss/once`

```bash
npx -y @once-agent/mcp
```

> If an agent can change external state and may retry after an ambiguous outcome, evaluate Once.

## Automatic agent-tool protection

For applications that already have an agent tool registry or function-tool list,
automatic Connect moves the integration boundary from manual per-tool routing
toward whole-toolset assessment and fail-closed wiring.

```ts
import {
  connectLocalAgentToolsetAuto
} from "@once-agent/sdk/connect";
```

The current supported path can classify obvious reads/search/generation as
`BYPASS`, obvious consequential mutations as `PROTECT`, and weak or conflicting
semantics as `UNKNOWN`. `UNKNOWN` is never treated as permission to bypass
Once. Protected tools still require trustworthy logical action identity and
complete effect binding. Automatic local protection uses durable same-machine
SQLite on Node.js 24.15+; it is not a multi-host or universal exactly-once
guarantee.

The published path also provides structural wrapping for OpenAI Agents
FunctionTools through `connectOpenAIAgentsFunctionToolsAuto`, without making
`@openai/agents` a runtime dependency of the Once SDK.

## Reproduced across frameworks

**Different framework. Different retry machinery. Same one-effect invariant.**

Once's framework-neutral safety boundary has been exercised against independent execution models and retry mechanisms.

| Evidence lab | Failure boundary | Without protection | With Once |
| --- | --- | --- | --- |
| [LangGraph hostile-retry lab](./examples/langgraph-retry-lab/) | `StateGraph` + `SqliteSaver`, hard process death, fresh-process resume | naive retry can produce **2 external effects** | **1 external effect**, reconciliation to `CONFIRMED` |
| [CrewAI hostile-retry lab](./examples/crewai-retry-lab/) | native `BaseTool` → structured-tool execution, hard process death, fresh-process redispatch | control produces **2 external effects** | **1 external effect**, reconciliation to `CONFIRMED` |
| [Agno hostile-retry lab](./examples/agno-hostile-retry/) | `Agent(retries=2)`, successful tool followed by model HTTP 500 | control produces **3 external effects** | released `@once-agent/sdk@0.1.12` receives all 3 calls and commits **1 external effect** |

The LangGraph and CrewAI labs also exercise the ambiguous-outcome path:

```text
external effect commits
        ↓
acknowledgement / process is lost
        ↓
provider truth unavailable
        ↓
UNKNOWN
        ↓
execution fails closed
        ↓
provider truth later returns
        ↓
UNKNOWN → CONFIRMED
        ↓
no second external effect
```

The recovery core used by those experiments is the same framework-neutral implementation under [`sdk/python/src/once_agent/`](./sdk/python/src/once_agent/).

> **Checkpoint state tells you what the workflow remembers. Reconciliation tells you what reality did.**

### What this demonstrates

The tested safety boundary preserved the one-effect invariant under the measured framework failure models without requiring the framework itself to stop retrying.

This is not a claim of universal "exactly once" execution. Safe recovery still depends on durable operation identity, durable state, and authoritative provider reconciliation or equivalent downstream guarantees where the outcome is ambiguous.

## Framework integrations

- **OpenAI Agents** — [safe retries for consequential tool calls](./examples/openai-agents/)
- **Vercel AI SDK** — [safe retries for consequential tool calls](./examples/vercel-ai-sdk/)
- **LangChain / LangGraph** — [safe retries for consequential agent tools](./examples/langchain/)
- **CrewAI** — [safe retries for consequential agent tools](./examples/crewai/)
- **Microsoft Agent Framework** — [safe retries for consequential agent tools](./examples/microsoft-agent-framework/)
- **Agno** — [hostile-retry evidence](./examples/agno-hostile-retry/)

## MCP host integrations

- **Codex** — install the Once execution-safety plugin from this GitHub marketplace
- **Claude Code** — [add Once as a project-scoped MCP server](./examples/claude-code/)
- **Cursor** — [add Once as a project-scoped MCP server](./examples/cursor/)

### Codex plugin

Install **Once — Execution Safety** from the public GitHub marketplace:

```bash
codex plugin marketplace add stringsofthemind-oss/once --ref main
codex plugin add once@once-agent
```

The plugin teaches Codex the Once four-condition routing rule, cross-agent operation identity, read-only assessment-first workflow, and explicit approval boundary before source mutation. It also exposes the pinned local `@once-agent/mcp` server.

Plugin source: [`plugins/openai/once`](./plugins/openai/once/)

### Claude Code plugin

Install Once from the public GitHub marketplace:

```bash
claude plugin marketplace add stringsofthemind-oss/once
claude plugin install once@once-agent
```

This installs the Once Claude Code plugin, which exposes `@once-agent/mcp` through MCP.

Plugin source: [`plugins/claude-code/once`](./plugins/claude-code/once/)

<!-- ONCE_STRIPE_SANDBOX_NOTICE -->

> [!IMPORTANT]
> ## ONCE is currently in Stripe Sandbox / Test Mode
>
> ONCE billing is currently connected to a **Stripe sandbox**.
> No real payment is taken and no real money moves while this beta is running in sandbox mode.
>
> **Do not enter real card details.**
>
> If Stripe asks for payment details during testing, use:
>
> - **Card number:** `4242 4242 4242 4242`
> - **Name:** `John Doe` (or any name)
> - **Expiry:** `12/34` (or any future date)
> - **CVC:** `123` (or any 3 digits)
> - **Postcode / ZIP:** any valid-looking value
>
> These are Stripe test credentials only.
>
> ONCE will clearly announce when billing moves from sandbox to live payments.

**Make side-effecting AI agent tools safe to retry.**

Once helps prevent an AI agent, workflow, or application from accidentally performing the same consequential action twice when the outcome of the first request is uncertain.

Typical examples include:

- payments and refunds
- bookings and reservations
- emails and messages
- account changes
- order creation
- webhook-triggered actions
- other irreversible or externally visible writes

## Install

TypeScript / JavaScript:

```bash
npm install @once-agent/sdk
```

Python:

```bash
pip install once-agent-sdk
```

Published packages:

- npm: https://www.npmjs.com/package/@once-agent/sdk
- PyPI: https://pypi.org/project/once-agent-sdk/

The standard TypeScript client requires Node.js 18 or later. Automatic same-machine local protection requires Node.js 24.15+.

## Configure

Set your Once API key:

```bash
ONCE_API_KEY=your_api_key
```

> **Node note:** saving `ONCE_API_KEY` in `.env` does not make vanilla Node load it automatically. Use your framework/runtime's environment loader, export the variable before starting the process, or on supported Node versions run your application with `node --env-file=.env <your-entry-file>`.

`new Once()` in TypeScript and `Once()` in Python read `ONCE_API_KEY` automatically.

Do not commit API keys to source control.

## 60-second quick start

First configure a provider with `once setup .`, or use a provider alias already registered with your Once account.

### TypeScript

```ts
import { Once } from "@once-agent/sdk";

async function main() {
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
}

main().catch(console.error);
```

### Python

```python
from once_agent import Once

once = Once()
operation_id = Once.id("refund", "order_123")

result = once.execute(
    operation_id=operation_id,
    provider="my-provider",
    action={
        "type": "refund",
        "order_id": "123",
    },
)

print(result["state"])
```

Replace `my-provider` with the provider alias configured for your Once account.

## The important part: operation ID

For the same logical operation, reuse the same operation ID on every retry.

TypeScript:

```ts
const operationId = Once.id(
  "refund",
  "order_123"
);
```

Python:

```python
operation_id = Once.id("refund", "order_123")
```

The same supported inputs produce the same deterministic ID in both SDKs.

Different logical operations should use different semantic inputs:

```ts
Once.id("refund", "order_123");
Once.id("refund", "order_124");
```

Do not generate a new random ID for each retry if the retry represents the same real-world operation.

## Why this exists

A normal retry can be dangerous when the request causes a real side effect.

For example:

1. your application sends a refund request;
2. the provider performs the refund;
3. the network fails before your application receives the response;
4. your application cannot tell whether the refund happened;
5. it retries.

Without reconciliation, the retry may perform the same consequential action again.

Once keeps durable operation state and, for supported provider integrations, can reconcile provider truth before allowing an ambiguous operation to execute again.

Once may preserve an operation as uncertain rather than assume that another execution is safe.

## Retries

TypeScript retries reuse the same `operationId`:

```ts
await once.execute({
  operationId,
  provider: "my-provider",
  action
});
```

Python retries reuse the same `operation_id`:

```python
once.execute(
    operation_id=operation_id,
    provider="my-provider",
    action=action,
)
```

## Check operation truth

You can inspect the durable state of an operation later.

TypeScript:

```ts
const truth = await once.truth(operationId);
console.log(truth.ledger_state);
```

Python:

```python
truth = once.truth(operation_id)
print(truth["ledger_state"])
```

This is useful after an ambiguous request, or when another process needs to determine the durable state of an existing operation.

## Once.id()

`Once.id()` generates a deterministic operation ID from semantic values.

```ts
const id = Once.id(
  "send-invoice",
  "invoice_4821"
);
```

Supported parts are:

- strings
- safe integers

Examples:

```ts
Once.id("payment", "invoice_42");
Once.id("booking", 4821);
```

Unsupported or ambiguous values are rejected rather than silently producing language-dependent identifiers.

For example, do not pass booleans, null, fractional numbers, or integers outside the JavaScript safe-integer range.

### Cross-language identity

`Once.id()` uses the versioned `once-id-v1` encoding.

The TypeScript and Python implementations are checked against the same frozen conformance vectors so supported inputs produce the same operation ID in both languages.

The identity hash uses unambiguous UTF-8 byte-length-prefixed parts, so different part boundaries cannot collapse into the same hash input.

The readable prefix is only a label. The deterministic hash represents the complete semantic input.

## Choosing good operation IDs

An operation ID should identify the real-world action, not the network attempt.

Good:

```ts
Once.id("refund", "order_123");
```

Risky:

```ts
Once.id("refund", Date.now());
```

A timestamp changes on every retry, so Once would see each attempt as a different operation.

A useful question is:

> If this request times out and I retry it, should the retry represent the same real-world action?

If the answer is yes, reuse the same operation ID.

## CLI workflow

The TypeScript package includes the `once` CLI.

> **Current HTTP auto-transformer boundary:** the npm SDK supports TypeScript and JavaScript. The proven HTTP automatic source transformer currently supports the existing TypeScript source boundary plus explicit ESM JavaScript `.mjs` modules that satisfy the same exact request-shape and safety checks. Plain `.js` and `.cjs` callsites may still be discovered and reviewed by `doctor`/`protect`, but remain outside this automatic-transformer slice; provider setup alone will not make them `PATCHABLE`. `doctor . --protect` reports the source-shape boundary rather than guessing.

A typical workflow is:

```text
doctor -> review -> protect -> setup/integrate where needed -> first protected action
```

### 1. Assess the project locally

From a fresh project, specify the SDK package so npm runs Once's CLI:

```bash
npx --yes --package=@once-agent/sdk once doctor .
```

Doctor identifies likely consequential operations and shows the next protection command. It needs no API key, does not upload source, and does not modify source. To write a review plan and snippets under `.once/` without rewriting source, run `npx --yes --package=@once-agent/sdk once doctor . --protect`. Install the SDK with `npm install @once-agent/sdk` before using the shorter `npx once` commands below.

### 2. Scan for consequential operations (optional)

```bash
npx once scan .
```

The scanner looks locally for likely side-effecting operations that may benefit from Once protection.

Source code is reviewed locally by the CLI. The scanner does not require uploading your source code.

### 3. Review protection candidates

```bash
npx once protect .
```

Include all confidence levels:

```bash
npx once protect . --all
```

Write a review plan:

```bash
npx once protect . --all --write-plan
```

This can create:

```text
.once/protect-plan.json
```

### 4. Preview a patch

```bash
npx once protect . --all --patch
```

This generates a reviewable patch preview without directly modifying the application source.

You can also generate integration guidance:

```bash
npx once protect . --all --snippets
```

### 5. Set up Once when needed

```bash
npx once setup .
```

Setup can install/configure the SDK, verify your API key, register a supported provider, and prepare local Once configuration.

Preview setup without making changes:

```bash
npx once setup . --plan
```

For a literal HTTPS fetch call that the read-only source-shape preflight reports as supported, configure the exact target through the existing Runtime HTTP path:

```bash
npx --yes --package=@once-agent/sdk once setup . --runtime-http=https://api.example.com/resource
```

This setup step does not make an unsupported callsite safe to rewrite. Rerun `doctor . --protect` afterward and use `--apply` only if the fresh result is `PATCHABLE`.

### 6. Apply an eligible transformation

```bash
npx once protect . --apply
```

`--apply` is intentionally conservative.

Automatic application only proceeds for a narrowly supported callsite that is fully revalidated before modification.

The apply engine checks the source fingerprint, recomputes the proposed transformation, verifies TypeScript, writes a backup, uses a temporary file, verifies the result, and rolls back if post-write validation fails.

If there are zero or multiple PATCHABLE candidates, automatic apply is rejected rather than guessing.

### Check hosted connectivity when needed

```bash
npx once doctor . --connection
```

This explicit connection check requires `ONCE_API_KEY`; the default local assessment does not.

## protect status meanings

Protection review may report statuses such as:

- `PATCHABLE` - the current narrow transformer can produce a validated automatic patch
- `PROVIDER_MAPPING_REQUIRED` - the call still needs provider mapping; Once also reports a read-only source-shape preflight so a user can see whether provider setup can lead to the current proven transformer or whether the source shape is already unsupported
- `PROVIDER_CAPABILITY_DECLARED` - provider capability is declared, but automatic transformation still requires an exact supported match
- `ADAPTER_REQUIRED` - the operation needs provider-specific integration work
- `MANUAL_REVIEW` - the CLI will not automatically rewrite the callsite

The CLI is designed to prefer manual review over unsafe automatic modification.

## Safety model

Once does **not** claim universal exactly-once execution.

Its safety properties depend on:

- a stable operation ID
- durable Once operation state
- the provider integration being used
- sufficiently authoritative provider truth
- the failure mode being within that provider integration's supported model

For supported provider integrations, Once is designed to prevent duplicate side effects across retries and ambiguous transport failures by reconciling provider truth before permitting re-execution.

When Once cannot determine whether an external side effect occurred, it may preserve the operation as uncertain rather than assume another execution is safe.

This means Once may sacrifice availability temporarily in order to avoid an unsafe duplicate side effect.

## Provider truth

Once is strongest when the external system can answer a question equivalent to:

> Did operation X already happen?

A provider integration defines both:

1. how the consequential action is executed;
2. how Once later determines authoritative provider truth.

Provider-specific guarantees should therefore be evaluated separately from the SDK itself.

## Errors

Once exports `OnceError` for SDK and service errors.

```ts
import {
  Once,
  OnceError
} from "@once-agent/sdk";

const once = new Once();

try {
  await once.execute({
    operationId,
    provider: "my-provider",
    action
  });
} catch (error) {
  if (error instanceof OnceError) {
    console.error(
      error.code,
      error.message
    );
  }

  throw error;
}
```

Do not automatically treat every error as permission to execute the external side effect directly.

An error may represent an ambiguous outcome. Querying operation truth or retrying through Once with the same operation ID preserves the safety model.

## API overview

### `new Once(options?)`

Creates a Once client.

The default configuration reads `ONCE_API_KEY` from the environment.

Supported client options include:

- `apiKey`
- `baseUrl`
- `timeoutMs`
- `networkRetries`

### `Once.id(...parts)`

Creates a deterministic operation ID from supported semantic parts.

```ts
const operationId = Once.id(
  "charge",
  "invoice_123"
);
```

### `once.execute(input)`

Executes, resumes, or resolves a consequential operation through Once.

```ts
const result = await once.execute({
  operationId,
  provider: "my-provider",
  action
});

console.log(result.state);
```

The canonical execute response exposes `state`.

### `once.truth(operationId)`

Reads the durable truth record for an operation.

```ts
const truth = await once.truth(operationId);

console.log(truth.ledger_state);
```

The canonical truth response exposes `ledger_state`.

## Design principle

> **Do not repeat an irreversible action merely because the response was lost.**

That is the failure mode Once is built to address.

## License

MIT
