# Merged fix comparison — 16 October 2026

The merged commit `7d3658ef1a1f61c4c18cc4781f6892460add960c` preserves completed sibling results. No published fixed wheel was verified as of this audit. PyPI latest was **2.12.0**, uploaded 13 October; its tag `38381f65f2bee0f70a89f938ee64e51b34916fa7` is not a descendant of the fix. Both modified runtime files in the wheel exactly match that affected tag and lack the completed-response helper. The wheel SHA-256 matches PyPI metadata. Behavior independently reproduces the defect.

| ADK | History raw / Once effects | Forced raw / Once effects |
| --- | --- | --- |
| PyPI 2.11.0 | 2 / 1 | 2 / 1 |
| Merged fix 7d3658e | 1 / 1 | 2 / 1 |
| PyPI 2.12.0 | 2 / 1 | 2 / 1 |

Each run has seven ADK runner cases, three protected boundary safety cases, three raw fresh-process controls and one lookup falsification control. Protected confirmed replay preserves the exact receipt; changed title/project/tenant yields CONFLICT; lost acknowledgement and hard exit after commit remain UNKNOWN in fresh processes. Unavailable and NOT_FOUND truth remain blocked. Exact authoritative fixture truth confirms without dispatch and subsequent replay returns that receipt. Each protected case independently counts one provider row.

Raw controls use separate Python processes. A confirmed call followed by deliberate same-input and changed-input calls creates three rows (no receipt replay or conflict enforcement). Lost-ack and crash cases each create one row and are reconciled read-only; **no ambiguous raw retry is performed**. These boundary controls run beside each ADK variant, not through the ADK runner. Raw and protected workers differ in implementation language; these are effect-count controls, not performance comparisons.

## Reproduce

From the Once repository root, use Python 3.12.10 and Node 24.19.0:

```sh
python -m venv .venv
# Activate .venv: POSIX source .venv/bin/activate; PowerShell .venv\Scripts\Activate.ps1
npm ci --prefix sdk/typescript
npm run build --prefix sdk/typescript
python -m pip install -r examples/adk-parallel-replay/requirements.lock.txt
python -m pip check
git clone https://github.com/google/adk-python.git upstream-adk
git -C upstream-adk fetch --tags origin
python examples/adk-parallel-replay/audit_release.py --upstream upstream-adk --output evidence/release-audit.json
python examples/adk-parallel-replay/verify.py --label release-2.11.0 --output evidence/release-2.11.0.json
git -C upstream-adk checkout --detach 7d3658ef1a1f61c4c18cc4781f6892460add960c
python examples/adk-parallel-replay/verify.py --adk-src upstream-adk/src --expect-kept --label merged-fix --output evidence/merged-fix.json
python -m pip install --no-deps google-adk==2.12.0
python -m pip check
python examples/adk-parallel-replay/verify.py --label release-2.12.0 --output evidence/release-2.12.0.json
python examples/adk-parallel-replay/check_evidence.py evidence/release-2.11.0.json evidence/merged-fix.json evidence/release-2.12.0.json
python examples/adk-parallel-replay/test_evidence.py evidence/merged-fix.json
```

The shared version lock now pins google-genai 2.30.0, satisfying both newer variants. Source-overlay runs validate declared direct dependency versions before importing ADK; installed distribution metadata still identifies the underlying 2.11.0 wheel, while `adk_source_revision` identifies executed source. Local 2.12.0 used the extracted, hash-verified wheel via PYTHONPATH with pip check; CI installs that same version. Dependencies are pinned, not a complete hash-locked supply-chain guarantee.

`audit_release.py` fetches PyPI JSON and verifies every wheel from 2.11.0 onward against the two affected source files in its Git tag and merged-commit ancestry. A missing tag or network error fails rather than guessing. `first_verified_fixed_release: null` means none was verified in that snapshot. Future releases require rerunning the audit and behavior suite; absence of an exact ancestry/file match does not disprove a differently implemented backport. No future version is automatically trusted.

## Initial local validation and limits

Local platform: Windows 11 build 26300, Python 3.12.10, Node 24.19.0. Base Once revision: `8381734a9be368138546121ae708ec9c55be8e89`, which contains merged PR #304. Original `evidence.json` is unchanged. New reports are under `evidence-2026-10-16/`.

Passed: three ADK variants and offline report checks; 58 focused SDK tests; FIRST 10 packed consumer; 14 wrapTool ESM/CJS package checks plus TypeScript contracts; proof and site guards; 12-worker concurrent boundary control with five invalid-shape rejections; five evidence falsification checks. Clean packed SDK 0.1.26 and published SDK 0.1.25 consumer reports are included separately. These package versions describe tested artifacts, not a new publication.

CI configuration retains historical PR-base/head cells and adds merged-fix and affected 2.12.0 cells, for ten Windows/Linux combinations. YAML parsed locally; **remote CI and Linux runs for this change have not been executed**. Full upstream tests and full SDK release suite were not rerun. No branch push, PR, release, publication or deployment was performed.

Initial runs exposed the old lock's GenAI 2.29 incompatibility; all final comparison evidence was regenerated after pinning 2.30 and passing dependency checks. Early environment setup and restricted temporary-storage attempts failed; subsequent isolated runs succeeded. Those failures are not counted as passes.

This is a separately rerun deterministic lab using the existing PR #304 harness, not an independently authored third-party audit. The scripted history decision is not live-model behavior. Provider effects and Once state are separate same-machine SQLite journals; provider counts are read independently of receipts but are not external attestations. ADK sessions remain in memory. Fresh boundary processes do not establish whole-framework crash recovery, distributed authority, cancellation correctness, production-provider behavior or universal exactly-once execution. UNKNOWN is never blindly retried.

## Final validation mission

The final mission reran the five local comparisons from clean checkout `687f94b` using Python 3.12.10 and Node 24.19.0. The new reports include exact Once revision, SDK version, logical action ID, regenerated model attempt IDs and CI URL when running under Actions. Historical reports above remain unchanged. The evidence checker now rejects substitution of a required scenario with a duplicate, as well as the earlier five falsifications.

The 58 focused SDK tests, FIRST 10 package consumer, 14 wrapTool package checks and source/site guards were rerun and passed. Current Cloudflare controls were read before publication: `test/*` preview branches excluded, production auto-deployment disabled, canonical production deployment `b99dd0f0-065d-4f6c-81df-f02f4f717e4e`. No configuration changes were made. GitHub Pages uses workflow builds; this change does not modify site files or a deployment workflow.

Current release audit again found no verified published fixed release. Official [2.12.0 release notes](https://github.com/google/adk-python/releases/tag/v2.12.0) and PyPI metadata were checked alongside source ancestry and wheel hashes. Final local reports are in `evidence-final-local/`.
### Cross-platform evidence

[ADK CI run 38893418234](https://github.com/stringsofthemind-oss/once/actions/runs/38893418234) passed all **10/10** cells: released 2.11.0, released 2.12.0, historical PR base, historical proposed fix and merged fix, each on Windows and Linux. This is 70 ADK runner scenarios, 30 protected safety cases, 30 raw controls and 10 lookup controls. Each cell also passed the six falsification checks. The concurrent boundary control passed on both operating systems.

All ten downloaded JSON reports were independently rechecked locally; [permanent machine-readable CI evidence](ci-evidence-2026-10-16.json) retains their full contents, artifact names and original SHA-256 digests. The tested PR head is `1746db6cee2c19b3bf15626a0ea39980330bf5da`; Actions checked out synthetic PR merge commit `96adab9d085216ebd0821c6a9bdb84a7cf540ce6`. Every report records a clean tree and SDK 0.1.26. These are source-build tests; the separate published-consumer local run uses SDK 0.1.25.

[Full regression CI](https://github.com/stringsofthemind-oss/once/actions/runs/38893418397) exercises the TypeScript release suite/safety regressions, Python SDK, MCP and plugin checks. [Worker CI](https://github.com/stringsofthemind-oss/once/actions/runs/38893418335), [HTTP BodyInit](https://github.com/stringsofthemind-oss/once/actions/runs/38893418218) and [HTTP response capability](https://github.com/stringsofthemind-oss/once/actions/runs/38893418276) passed. Full regression and all checks on the final head remain merge gates; their final outcomes and exact merge commit are recorded on [PR #315](https://github.com/stringsofthemind-oss/once/pull/315). Documentation/evidence-only follow-up commits run the same matrix again.

Classification: the listed local and ADK CI assertions **passed**; no final behavioral failures observed. Live-model, production-provider and distributed-authority qualification, whole-ADK process crash recovery, and the full upstream ADK unit suite are **untested**. Unsupported/malformed effects and unavailable authority **fail closed**. Early environment/dependency failures are described above and are not counted as passes. Delayed evidence is modeled by unavailable/NOT_FOUND probes followed by exact authoritative fixture truth, not a real eventually consistent provider.

No package version increase or package publication is justified: this PR changes tests, evidence and documentation only. No additional comment is posted on Google's closed issue, avoiding duplication of the existing Once report there. Google's history correction is useful and complementary to execution-boundary protection; it does not claim to solve forced redispatch or ambiguous external acknowledgements.
