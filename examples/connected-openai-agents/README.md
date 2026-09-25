# OpenAI Agents calls Once automatically at the tool boundary

This is a runnable example using the **published** `@once-agent/sdk@0.1.11`,
OpenAI Agents SDK and a fake booking provider. It uses the Agents SDK's
`ScriptedModel` to exercise the actual agent run loop and tool execution
without an API key, model charge, or external booking.

From this directory on Node.js 24.15 or later:

```bash
npm ci
npm run verify
```

Expected output: four agent runs, two provider effects, one replay and one
payload conflict. The model's tool-call ID changes on retry; the application
supplies the stable customer intent ID outside the model's tool arguments.
The agent has access only to the connected tool. It does not choose whether
or when to call Once.

**Connecting a real application:** attach the connected tool to your agent's
function-tool `execute` boundary, persist a stable ID for each *intentional*
action across retries, and bind every effect-changing input into `payload`.
Do not expose the original provider tool as another agent capability. This
example's provider is deliberately fake and confirms immediately. A real
provider needs a read-only authoritative reconciliation lookup when effects
can happen without acknowledgements. Unknown outcomes must block blind
redispatch. This local mode requires shared durable SQLite state on a single
machine. Multi-host deployments need a separate supported integration.

A scripted model validates framework integration, not whether a live LLM
will choose the right tool or reliably understand user intent. A live model
run requires API credentials and separate verification.
