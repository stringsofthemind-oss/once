# Silent Chicken — independently runnable qualification

This package contains unpublished source-built SDK 0.1.27 / MCP 0.2.3 tarballs,
the original eight-scenario baseline, twelve stronger host-admission scenarios,
a checker that imports no Once/MCP code, an actual pinned Summa42 service fixture,
raw results and an engineering/security/migration report. No real payments,
production accounts or commercial-provider actions are involved.

## Setup and run

Requires Node 24.15+ (qualified locally on 24.19.0), npm and two disposable
PostgreSQL instances. Docker Compose is one reproducible setup option; it is not
required if you already have isolated local test instances. The two fixture
clusters still share your physical machine, so this does not certify independent
physical failure/restore domains. First-time npm installation needs network.

```sh
npm ci --ignore-scripts --no-audit --no-fund
docker compose up -d --wait
```

Use these **synthetic local fixture** connection settings (never replace them
with production databases). Bash:

```sh
export ONCE_TEST_POSTGRES=postgresql://once_fixture:fixture-only-ci@127.0.0.1:54369/postgres
export ONCE_TEST_WITNESS=postgresql://once_fixture:fixture-only-ci@127.0.0.1:54370/postgres
npm test
```

PowerShell:

```powershell
$env:ONCE_TEST_POSTGRES='postgresql://once_fixture:fixture-only-ci@127.0.0.1:54369/postgres'
$env:ONCE_TEST_WITNESS='postgresql://once_fixture:fixture-only-ci@127.0.0.1:54370/postgres'
npm test
```

The tests explicitly create and remove their own randomly named fixture
databases/roles. They never initialize a missing production authority. The script
prints a fresh run directory containing provider journal/counters, event traces,
authority snapshots, outcomes, latency samples and available SQL/memory metrics.

```sh
npm run verify -- protected silent-chicken-runs/run-PRINTED_NAME
```

For the original vulnerable legacy configuration:

```sh
npm run test:baseline
npm run verify -- baseline summa42-runs/run-PRINTED_NAME
```

The second command is **expected to fail RED**: it requires a maximum of one
effect and observes two for baseline T06 and T07. The old baseline itself retains
all eight assertions, including its explicit counterexamples. In the new
protected profile, H01/H02 require one effect and deny identity/history
substitution. A separately host-admitted identical action still executes.

`vendor/` contains both exact Once candidates; `package-lock.json` pins public
dependencies and explicitly overrides the legacy MCP SDK pin with the qualified
SDK candidate. The override is an opt-in deployment choice. Installing MCP alone
with its unchanged published SDK 0.1.25 dependency does not enable this profile;
the capability is denied before provider execution. Legacy packed-consumer
compatibility is qualified separately.

## Actual Summa42 service proof

Follow `ACTUAL-SUMMA42.md` to clone/check out public Summa42 commit
`efc6794ea79a4be5b2f60e376833a1d03cba053c`, copy `reference/main.go` into its
`cmd/once-evidence/main.go`, and build using Go 1.27.1. The full source repository
is not embedded or modified upstream. Set `ONCE_SUMMA42_BINARY` to that executable
and `ONCE_SUMMA42_REVISION` to the pinned commit, then:

```sh
npm run test:summa42-host
```

The reference adapter exercises actual Summa42 operation/execution/resource/
SQLite services in fresh processes and kills the Go worker after commit. It does
not run the Box/LLM/global scheduler. The bridge token and provider credentials
are ephemeral fixture data, never tool arguments or saved evidence.

## Read the evidence

- `ENGINEERING.md`: implementation, architecture diagram, protocol, security,
  trust boundaries, compatibility and migration.
- `ACCEPTANCE.md`: Summa42 #35 criteria and scenario mapping.
- `validation.json`: exact commands, versions, exits, failures and release gates.
- `qualification/`: final local tests, actual service proof and original RED run.
- `performance.json`: measured fixture latency, logical SQL operations and memory;
  physical disk I/O, cloud prices, production throughput and HA are not inferred.
- `provenance.json`, `source/`, `SHA256SUMS.json`: source/build identity and file
  integrity. These are reproducibility metadata, not third-party certification.
- `GITHUB-RESPONSE.md`: factual maintainer update; posting status is recorded in
  `validation.json` rather than assumed from the presence of a draft.

Do not reset ledgers, mint IDs or infer success to unblock UNKNOWN. Without
authoritative provider truth, an abandoned reservation may remain UNKNOWN with
zero provider effects indefinitely. Production host credentials, verified TLS,
physical restore-domain separation, operational recovery and full scheduler gates
remain deployment responsibilities. No universal exactly-once claim is made.

When finished, `docker compose down -v` removes only these disposable Compose
fixture volumes. Preserve the printed evidence directories for independent review.
