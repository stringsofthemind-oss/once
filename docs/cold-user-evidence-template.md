# Once Cold-User Evidence Template

Use this form with `docs/cold-user-test-protocol.md`.

Do not store secrets, API keys, passwords, cookies, tokens, Authorization values, sensitive request bodies, private environment files, or unnecessary personal/customer data.

---

## Evidence identity

- Evidence ID:
- Protocol version:
- Date:
- Timezone:
- Tester label:
- Tester has used Once before: YES / NO / UNKNOWN
- Maintainer present during cold run: YES / NO
- Maintainer intervention required before cold run ended: YES / NO

If YES, describe the intervention at a high level without secrets:


## Starting environment

- Operating system:
- Relevant runtime versions:
- Once package/version or exact public artifact:
- Target project/framework:
- Host/tool surface:
- Provider/integration category:
- Existing `.once` state before run: YES / NO / UNKNOWN
- Public instruction source used:
- Public instruction revision/version if known:

## Timings

Use one clock source consistently.

- `T0_START`:
- `T1_INSTALLED`:
- `T2_FIRST_USEFUL`:
- `T3_FIRST_PROTECTED`:
- `T4_END`:

Derived:

- Install time:
- Time to first useful result:
- Time to first protected action:
- Total run time:

Use `NOT_REACHED` for milestones that were not reached.

## Installation result

- Result: SUCCESS / FAILURE / ABANDONED
- Public install path attempted:
- Redacted failure category, if any:
- Was the failure attributable to public instructions, environment prerequisites, package/tooling behavior, or unknown cause:

Short observation:


## First useful Once result

- Reached: YES / NO
- Outcome category:
  - PROTECTION_READY
  - PLAN_CREATED
  - BYPASS
  - BLOCK
  - UNKNOWN
  - UNSUPPORTED
  - ERROR
  - ABANDONED
- Command or public entry path used:
- Short redacted observation:


## Consequential integration attempted

Do not record the sensitive payload.

- Integration is a real user project or realistic external surface: YES / NO
- High-level operation class:
- Why duplicate execution would be undesirable:
- Integration/provider category:
- Was an actual external side effect attempted: YES / NO
- If no, why not:

## Once safety outcome

Select exactly one final cold-run disposition when possible:

- [ ] PROTECTED
- [ ] BYPASS
- [ ] BLOCK
- [ ] UNKNOWN
- [ ] UNSUPPORTED
- [ ] ERROR
- [ ] ABANDONED

If BLOCK or UNKNOWN:

- Reason category:
- Was a second external effect prevented: YES / NO / NOT_APPLICABLE / UNKNOWN

If UNSUPPORTED:

- Unsupported shape/integration category:
- Did Once remain fail-closed: YES / NO / UNKNOWN

If PROTECTED:

- Current verified protection/receipt condition satisfied: YES / NO / UNKNOWN
- Retry/ambiguity proof applicable to this run: YES / NO
- Number of observed consequential effects:
- Number of logical attempts/retries if observable:
- Independent observation method, without sensitive payloads:

## Tester understanding

Ask before coaching.

- Tester explanation, short paraphrase:
- Understanding assessment:
  - CLEAR
  - PARTIAL
  - INCORRECT
  - NOT_ASSESSED

## Friction observed

Check all that clearly occurred:

- [ ] INSTALL
- [ ] DISCOVERY
- [ ] UNDERSTANDING
- [ ] AUTO_WIRING
- [ ] UNSUPPORTED_SHAPE
- [ ] IDENTITY_BINDING
- [ ] PROVIDER_TRUTH
- [ ] VERIFICATION
- [ ] LATENCY
- [ ] DOCUMENTATION
- [ ] OTHER

Describe the earliest meaningful friction point:


Describe the highest-impact friction point:


## Abandonment / stop reason

- Cold run completed: YES / NO
- If no, stop reason:
  - tester requested maintainer help
  - private instructions were required
  - credential sharing would have been required
  - fail-closed boundary would have needed weakening
  - unsafe duplicate risk
  - environment materially changed by maintainer
  - tester abandoned
  - other

Short observation:


## Evidence integrity

- Any maintainer coaching before tester-understanding answer: YES / NO
- Any private/unpublished setup instruction used during cold portion: YES / NO
- Any product code changed during the cold portion: YES / NO
- Any safety boundary bypassed: YES / NO
- Any secret accidentally captured: YES / NO
- If a secret was captured, evidence was redacted before storage: YES / NO / NOT_APPLICABLE
- Protocol changed during this run: YES / NO

If any answer above could invalidate the cold result, explain:


## Counting decision

- Counts toward independent cold installs: YES / NO
- Counts toward real integrations: YES / NO
- Counts toward independently observable production-style protected operation: YES / NO

Reasoning should refer only to the frozen protocol definitions:


## Observation vs interpretation

### Observed facts

List only directly observed facts, timestamps, outcomes, and redacted error categories.


### Interpretation / hypothesis

List possible causes or product implications separately. Do not rewrite these as facts.


## Candidate next action

Do not automatically turn this into an engineering task. Record the evidence-informed candidate only.

- Candidate action:
- Evidence supporting it:
- Would it broaden the protection surface: YES / NO
- If YES, new deterministic proof contract required: YES / NO

## Links

- Related Phase 16 issue: #184
- Redacted screenshot/log links, if any:
- Related follow-up issue/PR, if created after evidence review:
