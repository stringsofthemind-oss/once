Prepared response for [Summa42 #35](https://github.com/SofiaFlux/summa42/issues/35). Not posted. Attach the evidence archive when sharing; no public artifact URL is asserted here.

---

I've prepared a small reproducible Once-side test package against the hostile acknowledgement-loss scenario in this issue.

It uses the existing Once registered MCP action, actual stdio worker processes and a stateful loopback provider with no native deduplication. Every accepted POST appends and fsyncs an independent provider journal. The raw control commits twice when blindly retried.

The canonical test saves one logical operation ID, commits one provider effect, drops the HTTP acknowledgement, kills the worker at an observed loss barrier, then starts replacement callers with different attempt/session identities and actual JSON-RPC request IDs. With the original ID and ledger, retries remain blocked (IN_FLIGHT, then UNKNOWN), including a simulated replanning handoff. Provider count remains one. Authoritative read-only lookup recovers the exact receipt, and another process replays it without a write or lookup.

The package includes eight scenarios, machine-readable results, journals, ordered traces, SQLite state, a separate checker with no Once/MCP imports, source provenance, setup commands and a criterion-by-criterion report. It also tests changed effect inputs, unavailable/invalid reconciliation, missing/corrupt/schema-lost state and confirmed replay across replacement. Final qualification details and retained development failures are in the report; the proof waits for the real lease deadline rather than editing SQLite time.

There are two important counterexamples in the suite: a fresh arbitrary operation ID can create another effect for the same real-world intent, and a schema-valid empty ledger substituted between host lifetimes can also allow another write. The host must own canonical intent identity and preserve or independently attest the original execution authority. These cases are reported as limits, not suppressed by the test results.

This demonstrates the retry-safety primitive under those conditions. It does not implement Summa42's scheduler/planner gate or establish the entire acceptance criterion about when replacement Attempts may proceed. The next integration step would be to bind Summa42's persisted External Operation identity to the protected boundary, gate planner progress on unresolved outcomes, and test ledger continuity in that host. UNKNOWN never grants permission to retry a write, mint a substitute ID or reset state. This is not a universal exactly-once claim.
