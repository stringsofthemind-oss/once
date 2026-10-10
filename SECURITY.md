# Security policy

## Report a vulnerability privately

Use [GitHub private vulnerability reporting](https://github.com/stringsofthemind-oss/once/security/advisories/new) for suspected vulnerabilities. Include the package version or commit, affected configuration, a minimal reproduction with synthetic data, the observed impact and any proposed mitigation.

Do not include credentials, customer data or real payment/booking details. Do not publish exploit details in a public issue before coordination. Reproductions must use disposable local fixtures or authorized sandbox accounts, never another person's system or real financial transactions.

For installation questions and non-sensitive bugs, use [GitHub issues](https://github.com/stringsofthemind-oss/once/issues). If private reporting is unavailable, open a public issue requesting a private contact route without disclosing the vulnerability.

## Version and configuration scope

Report issues in any version; older versions may require upgrading rather than a backport. This project does not currently promise a security-response SLA or a long-term support schedule. Refer to package release notes and the [support matrix](https://onceexec.com/support/) for current capabilities. TypeScript, Python, MCP and plugin releases are independently versioned.

Installing Once does not protect arbitrary tools. Protection requires a reviewed execution boundary, stable logical identity, complete effect/account binding and supported durable state. Keep provider-native idempotency. Separate hosts, ephemeral state and unqualified provider adapters require their own admission evidence; local fixture success is not production qualification.

## Suspected duplicate or uncertain execution

Stop new dispatches for the affected logical operation and preserve its identity, original durable authority and available provider evidence. Do not delete or initialize replacement state, mint a new identity to escape uncertainty, or bypass the protected path. UNKNOWN remains blocked until supported authoritative reconciliation establishes the outcome. Missing receipts and timeouts do not prove absence.

Privately report the relevant operation/state transitions with secrets and personal data removed. If credentials may have been exposed, revoke or rotate them through their owning provider. Preserve evidence before recovery and follow the integration's documented recovery procedure.

Once does not offer a universal exactly-once guarantee or an independent security certification. Security depends on the provider contract, credential ownership, storage continuity, integration and operational configuration.
