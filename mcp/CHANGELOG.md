# MCP 0.2.1 candidate

- Correct once_verify_connection: retain local diagnostics, explicitly report
  Cloud configuration/verification, request actual read-only Cloud checks when
  configured, and propagate failed checks. Tool names/input remain compatible.
- Add one compatibility/continuity matrix; correct stale release and timeout
  statements and distinguish default helper, opt-in action and reviewed proxy.
- No execution state-machine, ledger schema, plugin pin or private adapter change.
- Not published: current npm/Registry remains 0.2.0 until independently verified.

# MCP 0.2.0

- Add the opt-in `registered-action` subpath for one disposable local-test order action, with existing-ledger admission, restart/schema-loss rejection and startup SQLite admission locking. Requires Node 24.15+ and persistent same-machine state. No default registered provider action is added.
- Pin the helper to published SDK 0.1.25. SDK source/API is unchanged by this release.
- Preserve the eight-tool default developer surface and existing stdio proxy. Node 20+ remains supported for the default helper; SQLite proxy mode requires Node 24.15+.
- Exclude the private experimental GitHub adapter/host from the public tarball and exports. The repository utility produces a separate unpublished `private: true` bundle using the unchanged provider implementation.

Once protects only actions routed through an admitted boundary. UNKNOWN is not permission to execute again; authoritative matching provider evidence can recover a prior effect. Raw sibling connectors remain outside protection. No universal exactly-once claim is made.

Public website and existing plugin pins remain at their confirmed published versions until npm publication is independently verified. No SDK or public GitHub plugin release is included.
