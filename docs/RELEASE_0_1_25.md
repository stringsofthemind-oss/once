# SDK 0.1.25 — FIRST 10

This patch adds `once prove` (a controlled local refund fixture) and `once check [directory]` (read-only heuristic candidate assessment). Existing doctor and SDK APIs remain unchanged. Node 24.15+ is required for the local SQLite proof; the package's other paths retain their existing runtime contracts.

The proof starts a separate loopback HTTP provider with a flushed effect journal and starts a fresh caller process at each stage. It independently observes provider counts: two effects after an unprotected retry; one after protected replay, acknowledgement loss, blocked restarted retry, changed-effect conflict, unavailable/negative truth, authoritative reconciliation and recovered replay.

The fixture demonstrates this controlled provider, not an arbitrary application or real financial integration. `once prove` never calls user application code. `once check` uploads no source, changes no application files and cannot establish complete semantics or safety from absence of findings.

No state machine, durable schema, identity/fingerprint algorithm, provider authority or redispatch rule changed. UNKNOWN remains unresolved uncertainty. Only authoritative positive confirmation enables recovery; unavailable truth and absence do not permit local redispatch. Developers own identity and complete effect/account bindings. Preserve provider-native idempotency. No new framework adapter was added.

Publication gates: complete release and Linux CI matrix, source/standalone parity, packed ESM/CommonJS/types and new CLI consumers, package-content inspection and matching tested tarball integrity. Website installation pins are synchronized only after registry verification. MCP and Python versions and historical evidence pins remain independent.

FIRST 10 engineering readiness is not adoption: unaided independent proof, meaningful own-operation use and seven-day retention remain to be measured.
