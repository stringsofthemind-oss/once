# Changelog

All notable changes to Once are documented here.

## 0.1.3 - 2026-09-19

Documentation-only patch release.

### Fixed

- Replaced the unreliable one-shot Windows npm execution instructions with the verified public install flow.
- Install with: npm install @once-agent/sdk
- Then run: npx once setup .
- Verified npx once --help after a clean public npm install.
- Verified npx once setup . --plan after a clean public npm install.

No SDK execution logic changed in this release.



## 0.1.2 - 2026-09-19

Hardened release following the previously published 0.1.1 package.

### Added

- Interactive CLI activation through the Once sandbox customer flow
- Permanent activation-flow regression coverage
- Exact target-URL authorization through provider `allowed_urls`
- Permanent Customer Zero duplicate-prevention regression coverage

### Changed

- Added ESM and CommonJS package compatibility
- Excluded `.once` generated artifacts from source scanning
- Improved missing-configuration diagnostics for `protect --apply`
- Strengthened provider outcome reconciliation
- Public CLI examples explicitly target @once-agent/sdk to avoid the unrelated once npm package

### Safety

- Deterministic provider HTTP failures do not imply that no side effect occurred
- `FAILED_BEFORE_EFFECT` requires explicit provider proof of no execution
- Ambiguous credential issuance is not automatically retried
- Automatic transformation fails closed when the target URL is not explicitly authorized
- Once continues to make no universal exactly-once claim

### Validation

The 0.1.2 release candidate passed the complete core and SDK release suites, package-consumer tests, activation regression, packaged-artifact regression, Customer Zero duplicate regression, and live deployment checks.

## 0.1.1 - 2026-09-19

Release-candidate baseline for the Once TypeScript SDK and CLI.

### Added

- `once setup` onboarding flow
- `once scan` local consequential-operation discovery
- `once protect` protection review workflow
- `once protect --apply` conservative automatic transformation
- `once doctor` connection verification
- TypeScript SDK with ESM and CommonJS package support
- Stable operation-ID helpers
- Provider registration and capability handling
- Provider-truth reconciliation for supported integrations
- Durable operation-state handling
- Sandbox Stripe test activation flow
- CLI API-key acquisition and `.env` persistence
- Permanent duplicate-prevention regression coverage
- Package-consumer and packaging regression tests

### Safety

- Once does not claim universal exactly-once execution.
- Automatic source transformation fails closed when a callsite is not fully supported.
- Ambiguous provider outcomes remain uncertain unless authoritative provider truth proves otherwise.
- Retries must reuse the same stable operation ID for the same real-world action.

### Release validation

The 0.1.1 release-candidate baseline passed:

- core release suite
- SDK release suite
- clean package-consumer tests
- npm package dry run
- Customer Zero duplicate-prevention regression
- live sandbox contract checks
- production core status checks



