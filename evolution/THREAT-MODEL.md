# Evolution v0.1 threat model

## Assets and authority

Protected assets are Once execution semantics, the constitution, evaluator, holdout material, admission rules, evidence integrity and maintainer credentials. UNKNOWN never authorizes blind redispatch; missing receipts and temporary provider absence do not prove non-execution; changed effect-bearing data conflicts; logical identity remains developer-owned; success requires evidence.

The trusted maintainer process owns evaluation and records final decisions. Candidate proposals and `evolution/zone/strategy.json` are untrusted data. All other Evolution files are immutable to candidates. Trial approval is an explicit maintainer action bound to a receipt hash and permits only a later isolated overlay. Production promotion still requires human approval. No candidate inherits the primary implementation agent's publication authority.

## Candidate capabilities

Candidates select bounded fixed transformation operators. The kernel does not execute arbitrary candidate code, package installation scripts, candidate-authored shell commands or a candidate-supplied evaluator. The campaign scope is documentation and strategy data; a candidate cannot use that scope to modify SDK dispatch, reconciliation, durable state or conflict rules.

Generation and evaluation use isolated candidate material and distinct evidence/state paths. The trusted evaluator verifies baseline and protected material and reproduces results independently. A candidate's claimed PASS is not a receipt. Exact holdout cases are reserved for trusted evaluation rather than provided as proposal input. In a public source repository, test algorithms may be visible; hidden randomized cases should not be described as a secret algorithm.

## Threats and controls

| Threat | Required control and boundary |
| --- | --- |
| Repository or issue prompt injection | Treat text as evidence/data; it cannot expand fixed operators or authorize new actions. |
| Shell injection or candidate code execution | Do not interpolate candidate strings into shells or launch arbitrary candidate programs. Use validated declarative inputs. |
| Path traversal and filesystem escape | Validate normalized paths and containment; reject absolute escape paths and symlink substitutions. Candidate changes must remain within the approved scope. |
| Candidate modifies its parent or another candidate | Isolate mutable material and caches; verify parent/baseline and candidate provenance before evaluation. |
| Constitution, evaluator or promotion tampering | Protected-path admission rejection and reference-hash verification; intentionally test attempted edits, removed assertions and forged results. |
| Holdout overfitting | Keep exact generated cases outside candidate input; record reproducible failure metadata after evaluation. |
| Forged benchmark, receipt or log | Trusted process reruns measurements and produces decisions; hash-bound approval detects receipt-content changes. Do not trust candidate-generated success text. |
| Credential theft and network exfiltration | No production, npm, deployment or unrestricted GitHub mutation credentials in candidate inputs. Candidates have no arbitrary execution/network capability. |
| Dependency confusion or malicious package scripts | Fixed operators require no candidate dependencies; independently review any trusted implementation dependency change. |
| Runaway recursion or resource exhaustion | Bound generations, candidate count, input/diff size, disk use, subprocesses, retries and wall time; terminate rather than silently expand budgets. |
| Recursive privilege escalation | Strategy changes cannot alter kernel admission, protected paths, resource limits, credentials or human promotion authority. |
| Misleading experience gains | Separate document-order metrics and fixture timings from human comprehension, real-provider evidence and adoption. |

## Residual risks and claim boundaries

This is a restricted declarative trust architecture, not an operating-system sandbox for arbitrary malicious code. A trusted maintainer running a compromised kernel, a hostile administrator, a tampered runtime, or a malicious installed dependency can defeat application-level controls. Protected hashes need a trusted reference and do not make a hostile local account powerless. Separate worktrees alone do not isolate host credentials or filesystem permissions.

Candidate scope restriction reduces the attack surface; it does not justify claiming comprehensive prevention of arbitrary code exfiltration. A future version that executes generated source requires a stronger execution boundary, credential-free environment and independently reviewed network/filesystem isolation before enabling that capability.

Public tests, known fixed operators and deterministic fixtures can encourage overfitting. Protected randomized cases and independent replay help, but are evidence within a defined model rather than universal safety certification. The FIRST 10 controlled provider demonstrates its own fixture semantics; it does not certify a real refund provider or distributed operation.

The final test report must record which controls were actually exercised, dangerous mutations killed or surviving, tampering attempts rejected, resource-limit behavior and any unresolved gaps. This document specifies the intended boundary and limitations; it is not itself proof that every control passed.
