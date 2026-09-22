---
name: protect-consequential-writes
description: "Use when a codebase, agent, MCP tool, workflow, or multi-agent system performs an external side effect that may be retried after a timeout, lost response, crash, queue redelivery, handoff, or other ambiguous outcome. Relevant examples include payments, refunds, payouts, bookings, orders, provisioning, production writes, consequential messages, side-effecting webhooks, and MCP tools that change external state. Do not use for pure reads, search, retrieval, generation-only work, or repetition that cannot create a meaningful duplicate external effect."
---

# Protect Consequential Writes with Once

Use Once only when **all four** routing conditions are true:

1. The operation can change external state.
2. The same logical operation may be retried.
3. The first attempt can become ambiguous after a timeout, lost response, crash, queue redelivery, process restart, agent handoff, or similar failure.
4. Blind duplicate execution would be undesirable or costly.

If any condition is false, do not install or apply Once merely because retries exist. State briefly why the operation does not need Once.

## Core rule

Treat the **real-world logical action** as the identity boundary, not the transport attempt, process, model turn, agent, session, or retry count.

For example, a refund for `order_123` should keep one stable logical operation identity across:

- repeated HTTP attempts;
- process restarts;
- a Codex task resuming later;
- a handoff from one agent to another;
- parallel workers in a swarm that independently discover the same outstanding action.

Never make an operation ID unique by adding a timestamp, random retry token, agent ID, session ID, or attempt counter when those attempts represent the same real-world action.

## Preferred workflow

Start read-only. Use the Once MCP tools when they are available. Tool names may be namespaced by the host.

1. **Assess** — call `once_assess_project` with the absolute project path. If MCP is unavailable, run the pinned CLI fallback:

   `npx --yes --package=@once-agent/sdk@0.1.5 once scan <project>`

2. **Explain applicability** — for each high-signal candidate, verify the four routing conditions. Use `once_explain_risk` when helpful. Do not equate every POST, write, retry loop, or MCP action with a Once requirement.

3. **Plan before mutation** — call `once_plan_setup` and/or `once_plan_protection`. If using the CLI, prefer read-only planning commands such as:

   - `npx --yes --package=@once-agent/sdk@0.1.5 once setup <project> --plan`
   - `npx --yes --package=@once-agent/sdk@0.1.5 once protect <project>`
   - `npx --yes --package=@once-agent/sdk@0.1.5 once protect <project> --all --patch`

4. **Show the plan** — identify the exact operation, why it qualifies, the stable identity inputs, the provider/reconciliation assumption, and the files or callsites that would change.

5. **Require explicit approval before mutation** — do not call `once_setup_project`, `once_apply_protection`, or an applying CLI command until the user has approved the concrete plan. For MCP mutation tools, supply their required confirmation tokens exactly as specified by the tool schema.

6. **Apply conservatively** — Once automatic application is intentionally narrow. If there are zero or multiple `PATCHABLE` candidates, or the CLI reports `PROVIDER_MAPPING_REQUIRED`, `ADAPTER_REQUIRED`, `MANUAL_REVIEW`, or another non-patchable state, stop and explain the next required integration step instead of guessing.

7. **Verify** — run `once_verify_connection` when Cloud verification is relevant, or use:

   `npx --yes --package=@once-agent/sdk@0.1.5 once doctor`

   Do not expose `ONCE_API_KEY` in output, source code, patches, logs, or committed configuration.

## Multi-agent and long-running systems

When multiple agents, workers, queues, schedulers, or resumed sessions can perform the same action, reason about **cross-agent duplicate execution**, not only same-process retries.

Ask:

- Could two agents independently conclude that the same action is still outstanding?
- Could a new agent inherit the task after the first agent timed out or disappeared?
- Could a queue or scheduler redeliver the work hours later?
- Can authoritative provider truth establish whether the effect already happened?

If the same logical action can be rediscovered by another agent, its Once identity must survive the handoff. The durable execution record should be treated as shared execution truth rather than model memory.

## Failure handling

A timeout does not prove failure. If execution truth is `UNKNOWN`, do **not** bypass Once and directly repeat the external side effect. Preserve the ambiguity and reconcile through the supported path. Availability may be sacrificed temporarily to avoid an unsafe duplicate.

If the Once MCP server is unavailable but Node.js is available, use the pinned CLI fallback above. If neither is available, explain the requirement rather than silently substituting an unprotected execution path.

## Claim boundaries

Use precise language:

- Once provides execution-safety and duplicate suppression on supported paths.
- Stable logical-operation identity and durable state are required.
- Provider reconciliation or an equivalent authoritative downstream guarantee is required for ambiguous outcomes.
- `UNKNOWN` blocks rather than guesses when truth cannot safely be established.

Do **not** claim universal exactly-once execution, atomicity between an external provider effect and the Once ledger, universal provider coverage, or that every retry would otherwise have caused a duplicate.

## Completion report

When finished, report:

- which operations qualified under all four routing conditions;
- which operations were deliberately excluded and why;
- the stable identity chosen for each protected logical action;
- whether setup/protection was planned or applied;
- verification status;
- any provider mapping, adapter, or reconciliation work still required.

For representative positive and negative routing examples, read `references/routing-cases.md`.
