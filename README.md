# @once-agent/sdk

## Once — AI Agent Execution Safety

**MCP idempotency and safe retries for consequential AI agent writes.**

Once helps protect supported refunds, bookings, payments and other externally visible side effects from unsafe duplicate execution after ambiguous timeouts, lost responses and retries.

- Website: https://onceexec.pages.dev/
- MCP idempotency guide: https://onceexec.pages.dev/mcp-idempotency/
- AI agent retry safety: https://onceexec.pages.dev/ai-agent-retry-safety/
- MCP package: `@once-agent/mcp`
- Python SDK: `pip install once-agent-sdk`
- MCP Registry: `io.github.stringsofthemind-oss/once`

```bash
npx -y @once-agent/mcp
```

> If an agent can change external state and may retry after an ambiguous outcome, evaluate Once.

## Reproduced across frameworks

**Different framework. Different retry machinery. Same recovery protocol. Same one-effect invariant.**

Once's framework-neutral recovery core has been exercised against two independent execution models using hard process termination after an external effect becomes durable.

| Evidence lab | Failure boundary | Without protection | With Once |
| --- | --- | --- | --- |
| [LangGraph hostile-retry lab](./examples/langgraph-retry-lab/) | `StateGraph` + `SqliteSaver`, hard process death, fresh-process resume | naive retry can produce **2 external effects** | **1 external effect**, reconciliation to `CONFIRMED` |
| [CrewAI hostile-retry lab](./examples/crewai-retry-lab/) | native `BaseTool` → structured-tool execution, hard process death, fresh-process redispatch | control produces **2 external effects** | **1 external effect**, reconciliation to `CONFIRMED` |

Both labs also exercise the ambiguous-outcome path:

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

The recovery core used by both experiments is the same framework-neutral implementation under [`sdk/python/src/once_agent/`](./sdk/python/src/once_agent/).

> **Checkpoint state tells you what the workflow remembers. Reconciliation tells you what reality did.**

### What this demonstrates

The same recovery protocol preserved the one-effect invariant under the tested LangGraph and CrewAI failure models without changing the core between frameworks.

This is not a claim of universal "exactly once" execution. Safe recovery still depends on durable operation identity, durable local state, and authoritative provider reconciliation or equivalent downstream guarantees.

## Framework integrations

- **OpenAI Agents** — [safe retries for consequential tool calls](./examples/openai-agents/)
- **Vercel AI SDK** — [safe retries for consequential tool calls](./examples/vercel-ai-sdk/)
- **LangChain / LangGraph** — [safe retries for consequential agent tools](./examples/langchain/)
- **CrewAI** — [safe retries for consequential agent tools](./examples/crewai/)
- **Microsoft Agent Framework** — [safe retries for consequential agent tools](./examples/microsoft-agent-framework/)

## MCP host integrations

- **Claude Code** — [add Once as a project-scoped MCP server](./examples/claude-code/)
- **Cursor** — [add Once as a project-scoped MCP server](./examples/cursor/)

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

```bash
npm install @once-agent/sdk
```

Requires Node.js 18 or later.

## Configure

Set your Once API key:

```bash
ONCE_API_KEY=your_api_key
```

> **Node note:** saving `ONCE_API_KEY` in `.env` does not make vanilla Node load it automatically. Use your framework/runtime's environment loader, export the variable before starting the process, or on supported Node versions run your application with `node --env-file=.env <your-entry-file>`.


`new Once()` reads `ONCE_API_KEY` automatically.

Do not commit API keys to source control.

## 60-second quick start

First configure a provider with `once setup .`, or use a provider alias already registered with your Once account.

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

Replace `my-provider` with the provider alias configured for your Once account.

## The important part: operationId

For the same logical operation, reuse the same operation ID on every retry.

```ts
const operationId = Once.id(
  "refund",
  "order_123"
);
```

The same supported inputs produce the same deterministic ID.

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

Retries reuse the same `operationId`:

```ts
await once.execute({
  operationId,
  provider: "my-provider",
  action
});
```

## Check operation truth

You can inspect the durable state of an operation later:

```ts
const truth = await once.truth(operationId);

console.log(truth.ledger_state);
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

The package includes the `once` CLI.

A typical workflow is:

```text
setup -> scan -> protect -> apply -> doctor
```

### 1. Set up Once

```bash
npx once setup .
```

Setup can install/configure the SDK, verify your API key, register a supported provider, and prepare local Once configuration.

Preview setup without making changes:

```bash
npx once setup . --plan
```

### 2. Scan for consequential operations

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

### 5. Apply an eligible transformation

```bash
npx once protect . --apply
```

`--apply` is intentionally conservative.

Automatic application only proceeds for a narrowly supported callsite that is fully revalidated before modification.

The apply engine checks the source fingerprint, recomputes the proposed transformation, verifies TypeScript, writes a backup, uses a temporary file, verifies the result, and rolls back if post-write validation fails.

If there are zero or multiple PATCHABLE candidates, automatic apply is rejected rather than guessing.

### 6. Verify the connection

```bash
npx once doctor
```

`doctor` verifies that the SDK can reach the configured Once service.

## protect status meanings

Protection review may report statuses such as:

- `PATCHABLE` - the current narrow transformer can produce a validated automatic patch
- `PROVIDER_MAPPING_REQUIRED` - the call needs a provider mapping before protection can be planned
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

