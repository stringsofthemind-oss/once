# Private GitHub issue canary

This is one private experimental host-owned GitHub REST capability, not a wrapper around a ChatGPT connector or arbitrary GitHub dispatch. The public MCP 0.2.0 artifact excludes this adapter and host. No public GitHub plugin release is provided. Node 24.15+ is required. Ordinary startup only admits an existing valid original ledger; explicit provisioning is separate.

## Prepare the private bundle

From `mcp`, run `npm run build:private-github -- ABSOLUTE_NEW_BUNDLE_DIRECTORY`. This builds local MCP code and stages a separate `private: true` package containing the experimental GitHub adapter/host, installs pinned dependencies without lifecycle scripts, and creates a local marketplace and self-contained plugin. It never publishes npm. `bundle-evidence.json` records the source version, exact SDK version and package hashes. The private staged artifact differs from the public npm package even when its source version matches. Preserve the original external configuration, host task mapping and ledger across any bundle update; never provision a replacement for expected state.

## Trusted provisioning

Use a dedicated private personally owned disposable repository, with Issues enabled and no collaborators, integrations, webhooks, automation or production data. GitHub issue creation can generate notifications. A fine-grained PAT needs Issues read/write for only that selected repository and required Metadata read. Verify numeric `/user`, repository and repository-owner IDs. The current capability intentionally requires the authenticated user to own the private personal repository; organization repositories are unsupported.

Keep the token in a host-controlled file outside the bundle, cache, source and task workspace. Do not paste it into ChatGPT. Protect configuration, intent mapping, ledger and optional fault controls against task edits through local policy/OS permissions. Same-user filesystem access is not a secret isolation guarantee.

Store host configuration outside the installed cache:

```json
{
  "statePath": "C:/OnceCanary/operations.sqlite",
  "tokenPath": "C:/OnceCanary/github-token.txt",
  "authority": { "userId": 123, "ownerId": 123, "repositoryId": 456, "owner": "YOUR_PERSONAL_OWNER", "repo": "YOUR_DISPOSABLE_REPOSITORY" },
  "intents": { "BUG-17": "host-provisioned-operation-17", "BUG-18": "host-provisioned-operation-18" }
}
```

Values above are examples, not provisioned identities. Intent mapping is persisted independently of payload. Add references only for genuinely new authorized tasks, preserve existing mappings forever, and reject duplicate operation IDs. No model-visible intent allocation exists. Replacing configuration with new mappings is not a supported escape from existing history. Never restore a lost ledger by creating an empty replacement.

For a genuinely new installation only, run `node scripts/provision-private-github-ledger.mjs --explicitly-new-ledger ABSOLUTE_NEW_LEDGER ABSOLUTE_BUNDLE/plugins/once/runtime/package.json` from the source repository. This refuses every existing file, including an empty/corrupt one. Failed provisioning leaves the file for operator diagnosis; it does not reset it. The normal host refuses missing, empty, corrupt, incompatible or schema-lost ledgers. Keep the ledger outside the plugin cache and preserve it across updates/restarts/handoffs.

Set `ONCE_GITHUB_CONFIG` to the absolute configuration-file path in the desktop executor environment. The private plugin `.mcp.json` declares only that environment reference. Its launcher uses bundled code; there is no npx, raw provider or cloud fallback. The token is loaded by the local host, never by model-visible arguments. GitHub origin and API version are fixed in code, owner/repo/account/resource in host config. Read-only context returns task references, not credentials or operation IDs.

## Install into ChatGPT Work desktop

Open/trust the generated bundle directory as the local test project so its `.agents/plugins/marketplace.json` is discovered. Install Once from the `once-private-github` local marketplace. Alternatively configure a personal local marketplace to point at the same plugin using the documented marketplace-root path rules; do not overwrite another personal catalog. Restart/refresh the desktop app, verify the installed cached copy includes `runtime/node_modules`, and start a NEW local Work task with this plugin enabled and GPT-6.1 selected. Disable the builder-only Once plugin for this canary to avoid duplicate skill/tool ambiguity.

First perform read-only tool listing and `once_github_issue_context`: exactly the protected issue tool and read-only context should exist. This verifies runtime/config/account reachability but does not mutate GitHub or prove automatic routing. Work/task/plugin availability is account/policy/rollout dependent. A cloud fallback without the original local host must stop, never initialize alternate state.

Use an ordinary prompt: “Open a tracking issue for BUG-17 about the broken export button in the configured test repository. Title: Export button does nothing. Description: Clicking Export produces no download.” Do not name Once. Inspect the actual GPT-6.1 skill/tool trace and independently count provider issues. Task/schema metadata alone does not prove routing.

## Fault-controlled one-issue run

Optionally add `faultControlPath` pointing to a separate host-owned canary file containing `{"loseNextAcknowledgement":true,"lookupEnabled":false}`. Never add these fields to tool arguments. After GitHub returns a successful issue creation, the host consumes the one-shot flag and deliberately throws before returning a receipt to Once. Same-task retry remains UNKNOWN with lookup disabled. The operator can then set `{"loseNextAcknowledgement":false,"lookupEnabled":true}`: the same action performs authoritative read-only recovery. Repeat original inputs for retained replay; alter title/body under the same taskRef for CONFLICT. Exactly one correlated external issue should exist throughout. A genuine new task needs a distinct preprovisioned reference and may create another issue even for identical title/body.

The separate operator harness `scripts/github-live-canary.mjs --allow-disposable-provider-effects ABSOLUTE_BUNDLE ABSOLUTE_CONFIG TASK_REF ABSOLUTE_PROOF_OUTPUT` executes that real-provider sequence and independently reads GitHub for counts/references. It refuses an existing ledger operation or preexisting correlation. It does not prove installed GPT routing, and does not run in local tests. Run it with a different genuinely new task reference from the later installed GPT test. No live canary was performed merely by building the package.

## Reconciliation and limits

The host inserts `<!-- once-correlation:OPERATION_ID:SHA256 -->` after the user body. The digest binds contract, action, verified numeric account/repository authority, taskRef, title and body. The protected effect also binds the complete outbound body. Reserved-marker text, mentions, credential-shaped input and extra fields are rejected. No operation ID, API URL, repository override, header, token, raw operation or fault flag is model-selectable.

After ambiguity, authenticated listing uses `state=all` and pagination, excludes pull requests, and locates the exact correlation identity. Exactly one candidate must survive fresh direct issue retrieval, full title/body and author/repository verification, and final authority recheck. Failed, absent, duplicate, malformed, mismatched, incomplete or stale observations stay UNKNOWN. Provider Date/Age headers and a bounded observation window reject stale evidence; pagination has a finite bound and unsupported next links fail closed. Absence never permits a POST. Issue bodies are mutable, listings are not transactional snapshots, and this is not a global immutable provider deduplication guarantee.

Local fixture tests record independent provider-side JSONL IDs/counts and deliberately show that raw POSTs create duplicates. That control proves only fixture behavior; actual GitHub bypass evidence remains a separate live test, which would necessarily create additional disposable issues and is outside the one-issue acceptance run. This plugin cannot prevent separately authorized shell/browser/connector writes outside its boundary. Never claim universal exactly-once, arbitrary connector wrapping, or installed automatic routing from local test success.
