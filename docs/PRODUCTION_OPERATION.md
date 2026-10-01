# Operate one protected workflow

Choose a supported workflow and adapter before promising production protection.
Name an owner for unresolved operations. A successful synthetic proof is a useful
start, not production readiness.

## Before real provider writes

1. Review persisted intent, namespace and complete effect against actual outbound
   requests; confirm native provider idempotency and its retention window.
2. Ensure every caller uses the protected boundary. Review internal SDK retries,
   redirects and functions containing multiple effects.
3. Select persistent authority for the topology. Local SQLite does not coordinate
   separate hosts or isolated containers, and network filesystems are unsupported.
4. Exercise first execution, replay, conflict, lost acknowledgement, process death
   and read-only recovery against the provider sandbox. Count provider effects.
5. Validate receipt serialization and version compatibility before deployment.
6. Document UNKNOWN escalation, provider-read limits and alert ownership. Check
   subscription/quota changes preserve access to existing replay/reconciliation.

## State continuity, upgrade and rollback

Keep the state location and semantic identity stable across deployments. Back up
SQLite with a SQLite-compatible procedure that accounts for WAL; a copied main
file alone may be incomplete. Test recovery in an isolated sandbox.

An old backup may omit already-committed effects. Do not restore it and resume
writes on the assumption that missing rows prove absence. Stop writes, investigate
provider truth for the affected interval and retain unresolved intents. Live
session file checks cannot prove all cross-restart continuity or backup freshness.

The [continuity experiment](AUTHORITY_CONTINUITY.md) measured this boundary:
complete state loss and a stale pre-effect snapshot each allowed a second
controlled effect after restart. Treat this as an operational write-stop gate.

Do not change an identity algorithm, tool name, provider account, effect schema
or receipt format without testing existing confirmed and uncertain operations.
Rehearse upgrade and rollback with retained state. This branch does not introduce
a new storage schema or guarantee transparent arbitrary-version rollback.

## Hosted service

Inspect the [hosted readiness record](GATEWAY_HOSTED_PRODUCTION_READINESS_V1.md)
for deployment, credential, entitlement, retention and billing decisions. It is
not authorization to turn on production gates. Verify the deployed artifact,
route and configuration separately, including tenant isolation and durability
before provider dispatch.

Publish actual data handling, credential encryption/rotation, retention and
service support behavior before making security, compliance or availability
promises. An operation record is safety authority, not a disposable cache; do
not couple its deletion to a short audit-log or subscription retention policy.

Measure UNKNOWN count/age, recovery time, unreplayable receipts, conflicts,
contention, replay latency and manual operator effort. Keep payloads and secrets
out of telemetry by default. Downloads and scanner counts do not measure protected
production actions.
