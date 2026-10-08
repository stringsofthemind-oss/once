# MCP compatibility and execution authority

This is the authoritative compatibility matrix for the public MCP package.
The verified public npm/Registry MCP is **0.2.1** and SDK is **0.1.25**. Published site versions are recorded in `docs/published-versions.json` after independent verification.

| Surface | Version / pin | Node minimum | What installation provides |
|---|---|---|---|
| Default MCP helper | Published 0.2.1 | 20 | Eight assessment/setup tools; no protected provider action |
| Explicit MCP stdio proxy | Same MCP package | 24.15 | Only reviewed/configured upstream tool boundaries |
| Opt-in registered local-test order action | Introduced in MCP 0.2.0 | 24.15 | Host-owned disposable action; original valid same-machine ledger required |
| TypeScript SDK hosted client | Published 0.1.25 | 18 | Explicit hosted integration; credentials/provider setup required |
| SDK local SQLite / Connect / wrapTool | Published 0.1.25 | 24.15 | Only actions actually routed through that boundary |
| OpenAI/Codex plugin | Manifest 0.1.1; retained MCP pin 0.1.5 | 20 for helper | Developer helper surface; separate plugin review/release required |
| Claude Code plugin | Manifest 0.1.0; retained MCP pin 0.1.5 | 20 for helper | Developer helper surface; separate plugin review/release required |
| Private experimental adapter/host | Excluded from public npm | 24.15 | Separately provisioned private capability; no public connector support |

Use Node 24.15 or later when evaluating all public local modes. Package engines
declare Node 20 because the default helper supports it; they do not authorize
SQLite proxy/registered actions on Node 20. Plugin pins intentionally differ
from latest npm and must not be advanced merely to match numbers. The retained
MCP 0.1.5 helper does not contain the 0.2.1 verification correction.

## Installing MCP does not intercept sibling connectors

Default installation exposes assessment, planning, approved setup/protection,
diagnostics and historical proof information. An action is protected only when
it is routed through an admitted Once execution boundary. The registered helper
is opt-in; the proxy needs explicit reviewed upstream configuration and catalog
binding. Existing GitHub, Adobe and other sibling connectors are outside that
boundary unless separately integrated through a supported route. Their presence
in the same agent does not give Once authority over them.

## The ledger is execution authority, not a disposable cache

Changing, deleting, replacing, resetting, rolling back or switching to another
valid ledger changes protection history and may permit an external effect to
execute again. **The same filesystem path does not prove the same execution
history.** UNKNOWN blocks redispatch in retained history; losing that history is
a separate boundary.

Fresh installation deliberately provisions a new authority before its first
operation. Continuation/restart must admit and retain the original authority;
never automatically create a replacement when expected state is absent. Every
cooperating local caller must share the same original persistent same-machine
ledger. Separate files/hosts and network filesystems are not supported.

Backups must preserve a consistent SQLite snapshot including the relevant WAL
state. Restoring an older or unrelated valid snapshot can erase dispatch records
for effects that already happened; a successful integrity check cannot prove
continuity. Stop writers and reconcile recovery with authoritative provider
evidence before resuming. Do not reset state or mint a new identity to unblock
UNKNOWN. A backup restoration alone does not authorize replaying uncertain
writes.

Registered-action admission rejects missing, empty, corrupt and schema-lost
expected state. A running session can detect supported path loss/replacement.
These checks do not authenticate valid-looking row deletion, historical rollback
or substitution of another valid database after shutdown. Direct SDK callers and
other boundaries must not be assumed to have this registered-action admission
guard.

## Ledger identity decision

No ledger-generation mechanism is added in 0.2.1. An immutable ID with a trusted
host pin can detect a different instance, but a rolled-back copy of the same
instance retains its ID. An adjacent replaceable pin file is not independent
authority. A future opt-in design needs explicit provisioning/migration, trusted
pin storage, fail-closed startup and separately proven rollback protection; it
must not silently reinitialize existing users or imply continuity from an ID.

UNKNOWN is never permission to execute again. Changed effect under the same
logical identity conflicts. No universal exactly-once claim is made.
