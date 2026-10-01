# SDK 0.1.23 candidate — not published

Public registry remains **0.1.22**. Source package and lockfile prepare
**0.1.23**. Public onboarding pins and `published-versions.json` intentionally
remain 0.1.22 until registry publication is verified. MCP source still depends
on public 0.1.22; no MCP release is included.

## Release notes

This patch improves the first protected-action journey and operational clarity.
It includes a credential-free simulated first-action example in the package,
promotes the existing `once prove` command, clarifies identity/effect ownership
and UNKNOWN recovery, and improves Windows persistence test reliability.
It adds portability CI, current-onboarding consistency checks and a controlled
authority-continuity investigation. No execution-kernel or storage-schema
change is included. No new exactly-once, multi-host, backup freshness, security
or hosted availability guarantee is introduced.

**Measured limitation:** losing complete local authority or restoring a
pre-effect snapshot after commit allowed a second controlled effect. The
same-machine retained-state contract remains essential. Stop writes after
suspected authority loss and investigate provider truth. See
[continuity evidence](AUTHORITY_CONTINUITY.md).

## Gate

Status: **NOT READY for owner publication approval** until candidate verification
is attached and required portability CI has passed. Local Windows evidence is
not Linux/macOS evidence. Release preparation does not authorize publishing.

- [x] Review scoped source diff and unchanged kernel/schema.
- [x] Rebuild 0.1.23 ESM/CommonJS and inspect packed metadata and contents.
- [x] Full release, local, SDK, runtime, Python and MCP checks on Windows.
- [x] Packed first-action, Connect and Gateway protection checks.
- [x] Authority continuity with public 0.1.22 and candidate; simulated provider.
- [ ] Windows/Linux/macOS Node 24.15 portability CI; other supported Node gates.
- [x] Confirm guidance conspicuously excludes state loss/stale restore/multi-host.
- [ ] Owner reviews acceptance of operational limitations and release notes.
- [ ] Owner approves merge and npm publication separately.
- [ ] After approval only: publish exact reviewed tarball, verify npm integrity,
  update public pins/site metadata and MCP source dependency deliberately.
- [ ] Deploy documentation only with owner approval; verify deployed surfaces.

Five-minute/30-minute onboarding targets and £200/month packaging remain
unvalidated. Recruitment results are separate from release-test results.
