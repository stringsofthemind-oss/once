# SDK 0.1.26 candidate — development dependency and evidence wording

This is an unpublished release candidate. It incorporates the reviewed adoption-guidance changes from PR308 and pins the development MCP TypeScript SDK dependency to 1.32.1, outside the affected range for [GHSA-6qxp-vccf-f47h](https://github.com/advisories/GHSA-6qxp-vccf-f47h).

Diagnostic output distinguishes configured, discoverable and tested behavior. Read-only candidates and successful local fixtures do not establish real-provider qualification, independent adoption or production readiness.

The candidate also repairs an existing packaging defect: the advertised CommonJS `@once-agent/sdk/http-response-json` export lacked its compiled file. The existing helper is now included in the CommonJS build, with packed ESM/CommonJS import regression coverage; its implementation and public signature are unchanged.

No execution kernel, public export, identity/fingerprint algorithm, durable ledger schema, provider authority or redispatch rule changes. UNKNOWN remains blocked until authoritative reconciliation; changed effects conflict and confirmed results replay. Local SQLite still requires Node24.15+ and a retained same-machine authority. No ledger migration is required.

The patched MCP dependency is development-only; shipped SDK runtime dependencies remain unchanged. Compatibility is checked with serial release regressions, packed ESM/CommonJS/TypeScript consumers, and package content/API comparison. Windows results must be complemented by Linux validation of the exact candidate head before publication.

Publication must use the exact tested tarball and verify registry integrity and clean installed consumers afterward. `docs/published-versions.json` and public installation pins remain at 0.1.25 until 0.1.26 is independently verified in the registry. MCP and Python versions remain separate.

Rollback: applications can pin the previous published `@once-agent/sdk@0.1.25` while retaining the original operation identities and durable state. This patch does not change ledger formats or require destructive recovery. If publication verification fails, do not update current-version pins or fabricate release completion.
