# Actual Summa42 service integration qualification

`main.go` is a deliberately narrow reference provider and service fixture. It is built **inside** public Summa42 revision `efc6794ea79a4be5b2f60e376833a1d03cba053c`, because Summa42's operation/execution packages are Go `internal` packages. It runs real `operations.Service`, `execution.Service`, resource reservation/settlement, policy/admission and SQLite persistence in separate Go processes. It does not launch Box, an LLM, the global scheduler or the full planner.

The existing Summa42 host creates a durable Task/effect slot, separate from an Attempt. A trusted operator then admits that exact task/slot to Once. The reference bridge pins the original Summa42 operation ID, task ID, effect slot, canonical intent/fingerprint/revision, fixed provider account and complete order. Worker input cannot create another admission or choose a different slot. The bridge has a private loopback token held by the host; it is never an MCP tool argument. New real intents require separate trusted admission.

The driver calls the existing Once registered MCP action; it does not add an execution state machine or duplicate the provider receipt validator. A separate MCP recovery host refuses provider creates, so Summa42's `LookupOutcome` cannot turn a missing execution record into an effectful request. Missing Summa42 state is rejected before calling its initializing SQLite opener.

## Reproduction

First build/install the candidate Once SDK and MCP and supply **disposable**, separately provisioned execution and witness PostgreSQL connection settings as `ONCE_TEST_POSTGRES` and `ONCE_TEST_WITNESS`. Do not print production credentials. The evidence package includes a loopback-only Docker Compose fixture as an alternative to existing disposable local PostgreSQL instances.

```sh
git clone https://github.com/SofiaFlux/summa42.git /absolute/disposable/summa42
git -C /absolute/disposable/summa42 checkout efc6794ea79a4be5b2f60e376833a1d03cba053c
mkdir -p /absolute/disposable/summa42/cmd/once-evidence
cp examples/summa42-host-integration/main.go /absolute/disposable/summa42/cmd/once-evidence/main.go
cd /absolute/disposable/summa42
GOCACHE=/tmp/summa42-full-go-cache go test ./internal/operations/... ./internal/execution/... -count=1 -timeout 5m
GOCACHE=/tmp/summa42-full-go-cache go build -o /absolute/disposable/summa42-once-fixture ./cmd/once-evidence
```

Use Go 1.27.1. On Windows set `GOCACHE` and `GOPATH` to writable workspace directories, use an `.exe` output filename, and use PowerShell copy/directory commands. Then from Once:

```sh
ONCE_SUMMA42_BINARY=/absolute/disposable/summa42-once-fixture \
ONCE_SUMMA42_REVISION=efc6794ea79a4be5b2f60e376833a1d03cba053c \
node mcp/scripts/summa42-host-proof.mjs /absolute/evidence-output
```

PowerShell: set the two variables with `$env:ONCE_SUMMA42_BINARY` / `$env:ONCE_SUMMA42_REVISION`, then run the same Node script with a Windows output path.

The proof initializes a new disposable Summa42 database, admits its actual slot, commits one provider effect, drops acknowledgement and kills the Go worker while Summa42 still records `DISPATCHED`. Three new Go recovery processes remain blocked before replacement Attempt creation and retain `OUTCOME_UNKNOWN` / `UNRESOLVED` exposure. A read-only reconciliation gate runs before StartAttempt. Authoritative read-only reconciliation produces `CONFIRMED_EFFECT` / `SETTLED`; a further process replays without another provider read or write. The fsynced provider journal is independent of both Once and Summa42 ledgers.

The driver saves events, source/binary identity, the complete disposable Summa42 database and provider journal. Fixture database roles in this particular integration driver are privileged disposable principals; separate hardening tests qualify restricted runtime/admission/witness roles. No credential, actual customer data or production state should be added to an upstream contribution.

These are actual pinned Summa42 service results through a new reference provider, **not** an upstream-merged integration, full issue closure, scheduler-wide progression gate or production qualification. Replacing both independent histories and trusted host pins coherently, hostile administrators and compromised host credentials remain outside this proof.
