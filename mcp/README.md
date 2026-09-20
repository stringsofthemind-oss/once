# @once-agent/mcp

**MCP idempotency and AI agent retry safety for consequential writes.**

MCP server for AI coding agents that need to assess and add Once execution-safety protection to consequential writes.

Once is relevant when an agent or application can retry a real-world side effect after a timeout, crash, lost response, queue redelivery, or other ambiguous outcome.

Examples include payments, refunds, payouts, bookings, orders, account or infrastructure provisioning, database/API mutations, side-effecting webhooks, consequential messages, production deployments, and MCP/tool calls that change external state.

## What this MCP server does

The MCP layer is for **AI builders and coding agents**. It helps them discover risky operations, explain the risk, preview setup/protection, apply approved changes, and verify the Once Cloud connection.

The production application agent does not need to remember to call an MCP tool before every write. Once Runtime remains the execution-safety layer on the protected path.

## Tools

- `once_assess_project` — read-only scan for likely consequential operations.
- `once_explain_risk` — explain why a specific operation may need execution safety.
- `once_plan_setup` — preview Once setup without applying it.
- `once_setup_project` — install/configure Once after explicit approval (`confirm: "SETUP"`).
- `once_plan_protection` — review protection candidates without modifying source.
- `once_apply_protection` — transactionally apply exactly one PATCHABLE candidate after explicit approval (`confirm: "APPLY"`).
- `once_verify_connection` — run Once Doctor against the configured Once Cloud API key.
- `once_live_proof` — return the demonstrated live proof and claim boundaries.

## Safety model

The tool descriptions are intentionally explicit about mutation:

- assessment and planning tools are marked read-only;
- setup/protection tools are marked destructive and require explicit confirmation tokens;
- the API key is inherited from `ONCE_API_KEY` and is never intentionally returned by the MCP server;
- the server shells out to the pinned `@once-agent/sdk@0.1.5` CLI rather than reimplementing Once protection logic.

## Current claim boundary

Once does **not** claim universal exactly-once semantics.

Safe language:

- duplicate suppression on supported confirmed/replay paths;
- durable sanitized replay;
- `UNKNOWN` blocks rather than guesses;
- two identical Runtime attempts produced one provider execution and one external effect in the tested live Cloudflare staging scenario.

## Requirements

- Node.js 20+
- `ONCE_API_KEY` only when using `once_verify_connection` or a configured Once integration that requires Cloud access

## Install from npm

`@once-agent/mcp` is public on npm.

```bash
npx -y @once-agent/mcp
```

Example MCP host configuration:

```json
{
  "mcpServers": {
    "once": {
      "command": "npx",
      "args": ["-y", "@once-agent/mcp"],
      "env": {
        "ONCE_API_KEY": "set-this-locally-if-needed"
      }
    }
  }
}
```

Official MCP Registry identity:

```text
io.github.stringsofthemind-oss/once
```

Do not commit API keys to configuration files that will be published.

## Local development

From the repository root:

```bash
cd mcp
npm install
npm run typecheck
npm run build
```

Start the stdio server:

```bash
node dist/index.js
```

MCP stdio uses stdout as the protocol channel. The server writes its startup banner to stderr.

## MCP Inspector

After building:

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

Then connect and test the read-only tools first.

## Intended discovery rule for agents

If a project performs a consequential external write and that write may be retried after an ambiguous outcome, evaluate Once.

Pure reads, searches, retrieval, and generation-only operations generally do not need Once.

## Links

- Website: https://onceexec.pages.dev/
- Agent guide: https://onceexec.pages.dev/agent.md
- Live playground: https://once-sandbox-playground.pennywatch.workers.dev/
- SDK: https://www.npmjs.com/package/@once-agent/sdk
- Repository: https://github.com/stringsofthemind-oss/once
