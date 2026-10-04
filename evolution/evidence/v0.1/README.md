# Demonstration snapshot

These are kernel-written receipts from the complete Windows campaign on commit `04bfd3a61ca743c4476945984bb8f9ecd0be99e5`, before later integrity hardening and CI portability fixes. They are archived evidence, never executable input or production approval. The final PR's CI independently repeats the campaign with the current protected kernel on Windows and Linux. Original fixture paths refer to that historical run; reproduce results with the CLI rather than assume those paths exist on another machine.

The immutable baseline includes package/runtime/dependency and compiled SDK hashes. Six candidate receipts preserve both generations. The malicious evaluator edit was rejected. M1's 22 actual fault cases detected ten seeded SDK defects versus zero for M0's four replay/attempt cases; the protected hard evaluator independently killed all ten. Exact holdout seed and cases are disclosed only after evaluation, together with their prior commitment.

The owner-authorized maintainer explicitly approved M1's exact receipt for an isolated trial. Generation one actually used it, passed its generated safety cases and recorded prior lessons in provenance. No candidate was production-promoted. Documentation improvements are structural synthetic evidence, not measured human comprehension or adoption.

The raw journal/mutation logs and original candidate commits are preserved in the maintainer output archive and CI artifacts. Rollback pointers and exact patches accompany the original receipts. Local candidate commits are archived under `refs/evolution/v0.1/*` and in an incremental Git bundle; they are never merged or published automatically. CI does not publish the private state-sealing key.
