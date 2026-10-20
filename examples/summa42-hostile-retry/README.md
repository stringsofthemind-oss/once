# Once / Summa42 #35: bounded hostile-retry proof

This package exercises the existing Once registered MCP action over actual stdio MCP and a deliberately non-idempotent loopback HTTP provider. It uses disposable local order records, never payments or production accounts. The provider appends and fsyncs a separate journal and never reads Once's ledger.

## Run the standalone package

Requires Node **24.15 or later** with `node:sqlite`, npm, local loopback sockets and permission to launch/terminate disposable child processes. Tested on Windows x64 / Node 24.19.0. Linux/macOS are unverified. No Docker, credentials or API accounts are required. Allow approximately 40 seconds: the crash test waits for the real 30-second claim lease.

Extract the supplied archive, open a terminal in its directory, then:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
```

`npm ci` downloads public dependencies using the included lockfile; Once SDK and MCP are supplied as local source-built tarballs in `vendor/`. First-time dependency installation needs network access. No registry publication occurs. The package is self-contained with respect to the Once checkout, not an offline Node/npm distribution.

The runner prints a fresh `summa42-runs/run-...` directory containing `results.json`, `events.jsonl`, `execution.json`, TAP output, each provider journal and counters, and the disposable SQLite files. It never reuses prior test state. A failing assertion exits nonzero and leaves the evidence intact.

Verify the printed directory using a separate checker with **no Once/MCP imports**:

```sh
npm run verify -- summa42-runs/run-REPLACE_WITH_PRINTED_NAME
```

This checks recorded effect counts, acknowledgement-drop/kill ordering, distinct attempts/sessions/request IDs, blocked outcomes, reconciliation receipt equality and persisted confirmation. It checks evidence consistency; it is not a cryptographic attestation from a third party. Package SHA-256 values are in `provenance.json`, and delivered-file hashes are in `SHA256SUMS.json`.

## Run from the existing Once repository

Install locked dependencies and build both existing packages:

```sh
npm --prefix sdk/typescript ci --ignore-scripts --no-audit --no-fund
npm --prefix sdk/typescript run build
npm --prefix mcp ci --ignore-scripts --no-audit --no-fund
npm --prefix mcp run build
npm --prefix mcp run test:summa42
```

That route uses the MCP package's locked published SDK dependency (0.1.25). The delivered standalone qualification explicitly overrides it with the source-built SDK 0.1.26; both are labeled separately in the evidence. To rebuild the standalone source qualification:

```sh
npm --prefix mcp run package:summa42 -- /absolute/path/to/a/new/output-directory
```

Then generate its lockfile with `npm install --package-lock-only --ignore-scripts --no-audit --no-fund`, run `npm ci --ignore-scripts --no-audit --no-fund`, and `npm test` in the new directory. On Windows supply an absolute Windows output path. Repository builds require Git and the locked development dependencies. `source/` contains audit snapshots; `provenance.json` identifies the base and exact built packages. The accompanying patch contains the new tests and fixture instrumentation.

## Interpretation

Eight scenarios pass when all expected assertions hold. **Two successful tests deliberately demonstrate duplicate effects outside the supported contract:** a caller substitutes a new logical ID, or an operator supplies a schema-valid empty replacement ledger after restart. Do not interpret the suite's PASS as protection against those cases.

Read `EVIDENCE.md` for acceptance mapping, failure history and limits, and `GITHUB-RESPONSE.md` for the proposed, unposted maintainer response. UNKNOWN never authorizes another write.
