# Phase 15 — Zero-Friction Protection

## Product shape

Once should be a Swiss Army knife underneath and a seat belt on the surface.

The user-facing goal is one coherent flow that discovers the agent/tool environment, classifies consequential execution risk, identifies protection gaps, wires only proven-safe integrations after explicit approval, and verifies the resulting protection with a synthetic hostile-retry proof.

Once remains focused on execution correctness for consequential side effects. This phase does not turn Once into a generic prompt-security, DLP, RBAC, credential-vault or model-firewall platform.

## Phase 15A contract

The default local entry point must answer:

1. What environment and source operations were found?
2. What tool/capability surfaces were found?
3. Which records are BYPASS, OBSERVE, REVIEW, QUALIFY, PROTECT_PRIORITY or CRITICAL_GAP?
4. Is the project carrying a high-priority execution-safety gap?
5. What is the next explicit protection step?

The default assessment is local and read-only.

It must not:

- invoke a discovered tool;
- launch a configured stdio MCP server;
- contact a provider;
- require an API key;
- create `.once` state;
- install a package;
- modify application source.

Existing explicit mutation/network boundaries remain explicit:

- `doctor --connection` may contact the hosted Once API;
- `doctor --tools --tools-live=...` may enumerate an explicitly selected remote HTTP MCP server;
- `doctor --protect` may write review artifacts under `.once/` but not application source;
- `protect --apply` is the existing conservative source-mutation boundary;
- `setup` remains the installation/activation/provider-configuration flow.

## Later slices

### 15B — automatic wiring plan

Build one machine-readable plan mapping the discovered environment to existing Connect, Gateway, MCP and provider/reconciliation paths. No second execution engine is allowed.

### 15C — safe apply

Allow one explicit approval boundary to install/configure only supported adapters and transformations. All file changes must remain transactional, reviewable and fail-closed.

### 15D — reconciliation depth

Add provider truth adapters where Once can make stronger recovery decisions. Each adapter must define authoritative evidence for `CONFIRMED`, `ABSENT_PROVEN`, `MISMATCH` and `UNKNOWN`.

### 15E — hostile-retry proof

After wiring, run a synthetic/fake-effect proof that demonstrates one external synthetic effect across an effect-then-lost-ack retry scenario. Only print `ONCE PROTECTED` when the measured proof and configuration checks succeed.

## Invariants

- Discovery is not execution.
- Classification is not authorization.
- Reconciliation changes knowledge; it does not execute the protected mutation.
- `ABSENT_PROVEN` is retry-eligibility evidence, not an authorization bypass.
- `UNKNOWN` remains fail-closed.
- Gateway/Connect/protectLocal/runtime remain the execution authority.
- Tool/framework annotations are evidence, not a security boundary.
- The default onboarding path remains read-only until an explicit apply/setup boundary.
