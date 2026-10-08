# MCP 0.2.0

- Add the opt-in `registered-action` subpath for one disposable local-test order action, with existing-ledger admission, restart/schema-loss rejection and startup SQLite admission locking. Requires Node 24.15+ and persistent same-machine state. No default registered provider action is added.
- Pin the helper to published SDK 0.1.25. SDK source/API is unchanged by this release.
- Preserve the eight-tool default developer surface and existing stdio proxy. Node 20+ remains supported for these modes.
- Exclude the private experimental GitHub adapter/host from the public tarball and exports. The repository utility produces a separate unpublished `private: true` bundle using the unchanged provider implementation.

The real private GitHub trial recorded one protected POST/effect through acknowledgement loss, durable UNKNOWN, positive GET reconciliation to CONFIRMED, retained replay and changed-effect CONFLICT. Installed protected routing was also observed. The disabled-lookup retry was **not** live-tested. Approximately 160 seconds was time to first positive observation, **not** a measured consistency delay. This evidence does not establish public plugin provisioning/update readiness.

Once protects only actions routed through an admitted boundary. UNKNOWN is not permission to execute again; authoritative matching provider evidence can recover a prior effect. Raw sibling connectors remain outside protection. No universal exactly-once claim is made.

Public website and existing plugin pins remain at their confirmed published versions until npm publication is independently verified. No SDK or public GitHub plugin release is included.
