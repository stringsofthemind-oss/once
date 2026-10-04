# Once Evolution v0.1

Evolution is a bounded maintainer capability for evaluating software improvements. It does not change Once's public product boundary or grant a candidate authority to release, deploy, merge, or reinterpret safety. The same consequential logical action should only happen once; incomplete evidence remains incomplete evidence.

## Restricted trust architecture

The Evolution Zone contains declarative candidate proposals and the mutable strategy at `evolution/zone/strategy.json`. Proposals select from a bounded set of fixed operators. They are data, not executable plugins, arbitrary patches, shell commands, or unrestricted agent programs. Recursive improvement means changing an eligible strategy and actually using its independently evaluated version in a later isolated generation. Merely generating a strategy or agreeing with another agent does not demonstrate recursion.

Everything in `evolution/` other than that strategy is trusted kernel material: constitution, protected manifests, evaluator, promotion rules, tests and documentation. Candidates cannot edit these files. The kernel inspects candidate changes, verifies protected hashes and evaluates outside candidate authority. Ordinary Once execution safety remains outside the campaign's writable scope. Production publication credentials are not inputs to candidate generation or evaluation.

This architecture intentionally limits which improvements v0.1 can express. Fixed operators improve reproducibility and make candidate scope reviewable. They do not provide a general-purpose autonomous coding sandbox. The runtime trust boundary assumes a trusted maintainer process and trusted checked-out kernel; a hostile administrator or modified kernel is outside this boundary.

## First campaign

The bounded experience target is the FIRST 10 landing page. Its first runnable proof command appears before the existing Node 24.15+ prerequisite. The baseline structural metric is **one prerequisite-order violation** on that page and **zero** in `examples/first10/README.md`. This is repository evidence, not evidence that an unrelated human failed.

Candidate families are materially different:

- Prerequisite-first entry reorders the existing requirement before the first executable instruction, while keeping the one-command path and its safety boundaries.
- Evidence handoff helps readers locate the existing proof report and interpret independent counts, uncertainty and scope limits. It targets interpretation rather than setup order.

The public proof already needs one command. Evolution must not claim to reduce that below one or infer human comprehension time from fixture runtime. The synthetic observer's existing CLI run passed in 1.85 seconds on Windows with Node 24.19.0; it was a warm repository invocation, not a cold installation. Its controlled provider recorded two unprotected effects and one protected effect, with no unsafe redispatch. This observation does not establish adoption or real-provider safety.

Candidate ranking can improve within bounded fixed operators. A later generation must record which approved strategy it actually used and compare measurable results against the previous strategy. Any recursion claim requires independent admission, subsequent use and evidence distinguishing the generations. A structural metric improvement alone does not show better human retention.

## Maintainer commands

Keep campaign evidence in an output directory outside the repository:

```sh
node evolution/cli.mjs run --out <outside-repo>
node evolution/cli.mjs status --out <outside-repo>
node evolution/cli.mjs inspect --out <outside-repo>
node evolution/cli.mjs candidates --out <outside-repo>
node evolution/cli.mjs receipt --out <outside-repo>
node evolution/cli.mjs lineage --out <outside-repo>
node evolution/cli.mjs rollback-info --out <outside-repo>
node --test evolution/tests/*.test.mjs
```

Inspect the CLI's usage for any required campaign or candidate identifiers. Output records preserve baselines, candidate parentage, rejection reasons, evaluator evidence and rollback pointers. Failed candidates remain evidence; they do not become active application code.

Trial approval is bound to a specific receipt and its content hash:

```sh
node evolution/cli.mjs approve-trial <receipt-id> --receipt-sha256=<hash> --out <outside-repo>
```

This permits an isolated overlay for a later generation only. It does not promote changes to production. A candidate cannot create its own final admission result or approve itself. Explicit human production approval remains a separate gate, even when every technical check passes.

## Evidence and completion

Hard safety gates are binary and precede comparisons of experience, speed, diversity or diff size. Dangerous mutation survivors, evaluator tampering, protected-path changes, secret leakage and unsupported unsafe behavior reject a candidate regardless of its soft metrics. Evaluation records must identify the trusted evaluator and constitution, environment, baseline, changed files, test results and decision authority.

The final integrated validation results and campaign receipts are not established by this README. Consult the generated receipts and the final engineering report; do not treat a command list or planned test as a passing result. Windows/Linux regression, FIRST 10 preservation, mutation strength, isolation and subsequent use of an improved strategy must be verified independently.

Unrelated unaided developer use, meaningful own-operation protection, seven-day retention and ten retained users remain separate adoption goals. Synthetic cold-agent evaluation cannot satisfy them. See [the threat model](THREAT-MODEL.md) for the trust assumptions and residual risks.
