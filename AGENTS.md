# Once: protect one consequential operation

Evaluate Once when an external write may be retried, its first outcome can be ambiguous, and duplicate effects matter. If native idempotency or a database constraint fully solves it, use that instead. Harmless repeatable work does not need Once.

Start with `examples/first10/README.md`: run the refund fixture using published SDK 0.1.25, then read `examples/natural-placement/README.md` for a host-owned callback. Fixture PASS, installation, scanner findings, downloads and upstream fixes are not independent adoption.

The developer owns stable logical identity and complete effect/account fields. Never silently infer or apply them. Keep identity across retries; genuine new intents need distinct IDs. Do not store Authorization credentials in effects. Route all writes through the reviewed boundary; opaque internal retries remain outside it.

UNKNOWN means the original action may have succeeded. Never blindly redispatch, mint a new ID to escape uncertainty, bypass protection, or infer absence from a missing receipt. Reconcile only authoritative read-only provider truth. Preserve CONFIRMED replay, changed-effect CONFLICT, durable state and fail-closed unsupported shapes. Local SQLite needs Node 24.15+ and one persistent shared same-machine authority.

FIRST 10 adds `once check [directory]` (read-only heuristic candidates) and `once prove` (controlled fixture only). These commands are published in SDK 0.1.25. Preserve doctor and established APIs. Do not broaden frameworks for FIRST 10.

Build SDK; run FIRST 10 regression and relevant local/wrapTool tests; regenerate proof assets and run source/site guards. Validate packed SDK and published SDK consumers in clean directories. Publication, deployment, release and outreach require owner approval of concrete changes.
