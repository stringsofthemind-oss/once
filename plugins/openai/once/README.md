# Once for Codex

**Once — Execution Safety** packages Once for Codex as a Git-backed plugin with a discovery skill and the existing local Once MCP server.

It is intended for consequential operations that can be retried after ambiguous outcomes: payments, refunds, payouts, bookings, orders, provisioning, production writes, consequential messages, side-effecting webhooks, and state-changing MCP tools.

Pure reads, search, retrieval, generation-only tasks, and harmless repetition should normally bypass Once.

## Install from GitHub

```bash
codex plugin marketplace add stringsofthemind-oss/once --ref main
codex plugin add once@once-agent
```

The marketplace entry is repository-local at `.agents/plugins/marketplace.json`.

## What installs

- `skills/protect-consequential-writes/` — teaches Codex when Once applies, when it does not, and how to plan/apply protection safely.
- `.mcp.json` — starts the local `@once-agent/mcp@0.1.3` server through stdio.
- `scripts/once-mcp.cjs` — cross-platform pinned launcher for the MCP package.
- `evals/routing-cases.json` — five positive and three negative discovery cases for routing evaluation.

The MCP process runs locally. Source scanning and code planning remain local to the developer environment. `ONCE_API_KEY` is only needed for Cloud-backed verification or integrations that require Once Cloud.

## Recommended first prompts

- `Audit this repo for unsafe retries on consequential writes.`
- `Make this payment or refund safe after an ambiguous timeout.`
- `Check this agent workflow for cross-agent duplicate side effects.`

The useful test is an indirect one: Codex should recognize Once as relevant from the failure mode even when the user does not mention Once by name.

## Safety behavior

The skill encodes the canonical four-condition routing rule. It starts read-only, presents a concrete plan before source mutation, and requires explicit user approval before setup or automatic protection is applied.

For multi-agent and long-running workflows, the logical operation identity belongs to the real-world action, not to the model, agent, process, session, or retry attempt. A later agent handling the same logical refund, payout, booking, provisioning action, or other consequential write should reuse the same semantic operation identity.

If execution truth is `UNKNOWN`, do not bypass Once and directly repeat the side effect.

## Claim boundary

Once does not claim universal exactly-once semantics. Its safety model depends on stable operation identity, durable state, the supported integration path, and sufficiently authoritative provider reconciliation or an equivalent downstream guarantee.

## Validate the package

From the repository root:

```bash
node scripts/validate-openai-plugin.mjs
```

This validates the Codex manifest, marketplace wiring, MCP launcher, skill metadata, pinned package versions, and the minimum positive/negative routing suite.

## Current distribution stage

This package is for Git-backed Codex/ChatGPT desktop marketplace testing first. A universal public-directory submission is a separate stage and will require the public submission package, legal/support URLs, review test cases, and any remote MCP capabilities required by the submitted experience.
