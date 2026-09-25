# Once Tool Importance Model

Last updated: 2026-09-25

Purpose: give Universal Tool Discovery a deterministic way to separate harmless capabilities from consequential tools that deserve Once qualification and protection attention.

The model deliberately separates **what a tool can do** from **how urgently Once should act on it**.

A high importance value must never itself authorize execution, source modification, server launch, or interception. Discovery remains read-only. The existing Once four-condition test remains the final qualification gate.

## 1. Three separate decisions

Every discovered tool gets three independent outputs:

1. **Effect class** — what kind of state can the tool change?
2. **Criticality score** — how serious could a duplicate or mistaken execution be? `0–100`.
3. **Action priority score** — how urgently should Once review/protect this tool in this actual environment? `0–100`.

Do not collapse these into one opaque AI score.

Example:

- `refund_payment` can have criticality `92` because it moves money.
- If it exists only in a public registry and is not installed, its action priority may be `12`.
- If it is model-visible, has been executed, is retryable, and has no protection, its action priority may be `96`.

This lets Once focus on tools that are both consequential **and actually exposed**.

## 2. Effect classes

### `READ_ONLY`

Examples:
- search
- list/get/read operations
- weather lookup
- fetch URL
- database SELECT
- file read

Default criticality: **0–10**.

Once action: inventory/bypass. Do not route through Once merely because the tool exists.

### `GENERATION_ONLY`

Examples:
- text generation
- summarization
- local reasoning
- image generation with no external publish/write

Default criticality: **0–10**.

Once action: bypass unless the tool itself performs an external side effect.

### `LOCAL_MUTATION`

Examples:
- write/rename/delete local files
- modify local project configuration
- local SQLite mutation

Default criticality: **15–40**.

Escalate when the mutation affects secrets, build/release state, executable code, or destructive operations.

### `EXTERNAL_LOW_IMPACT_MUTATION`

Examples:
- add a label
- update non-sensitive metadata
- record analytics/event state
- refresh a cache

Default criticality: **25–45**.

### `EXTERNAL_COMMUNICATION`

Examples:
- send email/SMS
- post Slack/Teams/Discord message
- send customer notification
- publish a comment

Default criticality: **40–65**.

Duplicate execution is externally visible and may affect humans even when no money moves.

### `EXTERNAL_BUSINESS_MUTATION`

Examples:
- create/update/cancel order
- create/cancel booking or reservation
- create ticket/issue
- modify CRM/customer record
- provisioning request

Default criticality: **50–75**.

### `DATABASE_MUTATION`

Examples:
- INSERT/UPDATE/DELETE/UPSERT
- schema/data migration
- destructive database command

Default criticality: **45–85** depending on scope and reversibility.

### `QUEUE_EVENT_MUTATION`

Examples:
- enqueue job
- publish Kafka/SNS/PubSub event
- trigger workflow

Default criticality: **45–75**.

A duplicate event may fan out into multiple downstream effects, so blast radius matters heavily.

### `STORAGE_MUTATION`

Examples:
- upload/replace/delete external object
- mutate blob/document storage

Default criticality: **35–75**.

### `CODE_REPOSITORY_MUTATION`

Examples:
- create/merge pull request
- push commit/tag
- create release
- modify branch/ref

Default criticality: **45–85**.

Production/release mutations should score near the upper end.

### `MONEY_MOVEMENT`

Examples:
- charge
- refund
- transfer
- payout
- capture payment
- create financial order

Default criticality: **75–100**.

These are prime Once candidates when retries can become ambiguous.

### `IDENTITY_ACCESS_SECURITY`

Examples:
- create/delete/disable user
- grant/revoke role
- rotate credential
- change auth/security policy
- modify secrets

Default criticality: **75–100**.

### `PRODUCTION_INFRASTRUCTURE`

Examples:
- deploy production
- scale/replace service
- terraform apply/destroy
- kubectl mutation
- DNS change
- cloud resource creation/deletion

Default criticality: **70–100**.

### `DESTRUCTIVE_ADMIN`

Examples:
- delete account/resource
- purge data
- destroy environment
- terminate service
- irreversible admin action

Default criticality: **85–100**.

### `DYNAMIC_EXECUTION`

Examples:
- arbitrary shell
- computer-use tool
- generic HTTP request tool
- code execution
- browser automation with unrestricted actions

Default criticality: **50 review floor** until the actual operation is known.

These tools are not always dangerous, but their effect cannot be inferred safely from the tool name alone. Once should classify each observed invocation more specifically when possible.

### `UNKNOWN`

Insufficient evidence to classify.

Default criticality: **50 review floor**, confidence low.

Unknown does not mean dangerous. It means Once should not silently treat the tool as safe.

## 3. Consequence modifiers

Start from the effect-class range, then apply explicit modifiers. Cap criticality at `100`.

Recommended modifiers:

| Signal | Criticality adjustment |
| --- | ---: |
| irreversible/destructive | +15 |
| direct money movement | +15 |
| privileged/admin/security scope | +12 |
| production environment | +12 |
| bulk/multi-record action | +10 |
| downstream fan-out/queue trigger | +8 |
| externally visible human communication | +6 |
| regulated/sensitive data effect | +6 |
| clearly reversible/local-only | -10 |
| authoritative proof of read-only behavior | force to 0–10 |

These are deterministic policy inputs, not LLM vibes. A model may help interpret descriptions, but the reason codes and inputs must remain visible.

## 4. Criticality bands — the human-friendly importance value

Every tool receives both a numeric score and a simple band:

| Band | Score | Meaning | Default Once treatment |
| --- | ---: | --- | --- |
| `I0` | 0–9 | negligible/read-only | bypass, inventory only |
| `I1` | 10–29 | low | observe |
| `I2` | 30–49 | moderate | review if exposed/used |
| `I3` | 50–69 | important | run four-condition qualification |
| `I4` | 70–84 | high | prioritize qualification/protection |
| `I5` | 85–100 | critical | immediate attention if exposed and unprotected |

Use `I0–I5` for consequence importance. Do **not** reuse `P0/P1/...`, because the discovery-source catalog already uses P-levels for engineering implementation priority.

## 5. The Once four-condition qualification gate

A score never replaces Once's actual routing rule.

A tool qualifies for Once only when all four are true:

1. it can change external state;
2. the same logical operation may be retried;
3. the first attempt can have an ambiguous outcome;
4. blind duplicate execution would be undesirable/costly.

Store qualification separately:

- `NOT_APPLICABLE`
- `UNLIKELY`
- `REVIEW_REQUIRED`
- `QUALIFIED`
- `UNKNOWN`

A critical tool that cannot be retried may be `I5` but `NOT_APPLICABLE` to Once.

A moderate business write may be `I3` and `QUALIFIED`, making it an actionable Once candidate.

## 6. Action priority score

Criticality describes the intrinsic consequence. Action priority describes **what Once should look at first right now**.

Start with criticality, then adjust using exposure, qualification, and protection state.

### Exposure/evidence modifiers

| Evidence | Action-priority adjustment |
| --- | ---: |
| `EXECUTED` | +15 |
| `MODEL_VISIBLE` | +10 |
| `RUNTIME_REGISTERED` | +7 |
| `SERVER_AUTHORITATIVE` | +4 |
| `HOST_CONFIGURED` | +2 |
| `SOURCE_DISCOVERED` only | +0 |
| `REGISTRY_CANDIDATE` only | -30 |

Use the strongest applicable evidence, not the sum of every evidence level in the chain.

### Qualification modifiers

| Qualification | Adjustment / rule |
| --- | --- |
| `QUALIFIED` | +15 |
| `REVIEW_REQUIRED` | +5 |
| `UNKNOWN` | +5 and retain review flag |
| `UNLIKELY` | -20 |
| `NOT_APPLICABLE` | force action priority to 0–15 |

### Protection modifiers

| Protection state | Adjustment |
| --- | ---: |
| no known protection | +10 |
| native idempotency key only | -5 |
| authoritative downstream idempotency/reconciliation | -15 |
| Once protected + healthy | -35 |
| Once protected but unhealthy/unverified | no reduction; raise review flag |

Clamp final action priority to `0–100`.

The action score is for ordering attention, **not for automatically executing or rewriting anything**.

## 7. Action bands

| Action score | Action band | Once behavior |
| ---: | --- | --- |
| 0–19 | `BYPASS` | show only in inventory if useful |
| 20–39 | `OBSERVE` | keep graph entry, no protection prompt |
| 40–59 | `REVIEW` | explain uncertainty/consequence |
| 60–79 | `QUALIFY` | run/complete four-condition test |
| 80–94 | `PROTECT_PRIORITY` | prominently surface if `QUALIFIED` and unprotected |
| 95–100 | `CRITICAL_GAP` | highest remediation priority if `QUALIFIED` and unprotected |

Discovery by itself must never block the developer's tool. Blocking/fail-closed behavior applies only after an operation is actually routed through a supported Once protection boundary.

## 8. Tool families and starting values

Recommended initial policy table:

| Tool family | Example | Starting criticality |
| --- | --- | ---: |
| search/read | `get_weather`, `list_orders`, `read_file` | 0–5 |
| generation | `summarize`, `generate_text` | 0–5 |
| local file write | `write_file` | 20 |
| local file delete | `delete_file` | 35 |
| external metadata | `add_label` | 30 |
| issue/ticket creation | `create_issue` | 45 |
| message/email send | `send_email`, `post_message` | 55 |
| external object upload | `upload_object` | 50 |
| database update | `update_customer` | 60 |
| database delete | `delete_record` | 75 |
| queue/event publish | `publish_event` | 60 |
| booking/order creation | `create_booking`, `create_order` | 65 |
| booking/order cancellation | `cancel_booking` | 70 |
| repository push/tag | `git_push`, `create_tag` | 65 |
| merge PR | `merge_pull_request` | 75 |
| publish release | `publish_release` | 80 |
| production deploy | `deploy_production` | 85 |
| refund | `refund_payment` | 90 |
| charge/capture | `charge_card`, `capture_payment` | 92 |
| transfer/payout | `transfer_funds`, `create_payout` | 95 |
| user/role permission change | `grant_admin`, `revoke_access` | 90 |
| credential/secret rotation | `rotate_api_key` | 92 |
| destructive production action | `terraform_destroy`, `kubectl_delete_prod` | 98 |
| arbitrary shell | `shell_exec` | 55 until invocation known |
| computer/browser automation | `computer_use` | 55 until invocation known |
| generic HTTP tool | `http_request` | 50 until method/target known |
| unknown dynamic tool | unknown | 50 review floor |

These are starting policy values, not universal truths. Provider-specific adapters may refine them with stronger evidence.

## 9. Invocation-level refinement

Some tools are too generic for a single permanent score.

Example:

`http_request` itself may be `I3 / 50`, but invocation analysis can classify:

- `GET /weather` → `READ_ONLY`, criticality `2`
- `POST /messages` → `EXTERNAL_COMMUNICATION`, criticality `55`
- `POST /refunds` → `MONEY_MOVEMENT`, criticality `90`
- `DELETE /production/database` → `DESTRUCTIVE_ADMIN`, criticality `98`

The same applies to shell, browser/computer-use, SQL, cloud CLI, and generic MCP gateway tools.

Prefer **invocation-level classification** whenever actual method/command/target semantics are available.

Do not persist raw arguments by default. Store redacted semantic facts such as method, provider/tool identity, command family, and target class.

## 10. Suggested canonical Tool Graph fields

Extend the Universal Tool Graph record with:

```json
{
  "once": {
    "effect_class": "MONEY_MOVEMENT",
    "criticality": {
      "score": 92,
      "band": "I5",
      "confidence": 0.96,
      "reasons": [
        "direct_money_movement",
        "external_state_change",
        "duplicate_harm"
      ]
    },
    "qualification": "QUALIFIED",
    "action_priority": {
      "score": 100,
      "band": "CRITICAL_GAP",
      "reasons": [
        "executed",
        "qualified",
        "unprotected"
      ]
    },
    "protection": {
      "once": false,
      "native_idempotency": false,
      "authoritative_reconciliation": false
    }
  }
}
```

Also preserve:

- `classification_version`
- `policy_version`
- `classified_at`
- strongest evidence level
- source adapter

so a future policy update can rescore the graph deterministically.

## 11. Confidence is separate from importance

Never confuse high consequence with high certainty.

Examples:

- `refunds.create` from a Stripe MCP schema may be criticality `I5`, confidence `0.99`.
- `execute()` from an unknown SDK may be criticality floor `I3`, confidence `0.25`.
- `get_weather` may be `I0`, confidence `0.99`.

For low-confidence `I3+` tools, prefer `REVIEW_REQUIRED` instead of pretending classification is certain.

## 12. Example prioritization

Imagine Once discovers these tools:

| Tool | Evidence | Criticality | Qualification | Protection | Action priority |
| --- | --- | ---: | --- | --- | ---: |
| `get_weather` | EXECUTED | I0 / 2 | NOT_APPLICABLE | none | 5 / BYPASS |
| `send_email` | MODEL_VISIBLE | I3 / 55 | QUALIFIED | none | 90 / PROTECT_PRIORITY |
| `create_issue` | HOST_CONFIGURED | I2 / 45 | REVIEW_REQUIRED | none | 62 / QUALIFY |
| `refund_payment` | EXECUTED | I5 / 92 | QUALIFIED | none | 100 / CRITICAL_GAP |
| `refund_payment` | EXECUTED | I5 / 92 | QUALIFIED | Once healthy | 87 intrinsic, but protection state = protected/monitor |
| `terraform_destroy` | SOURCE_DISCOVERED | I5 / 98 | REVIEW_REQUIRED | none | 100 / CRITICAL_GAP review |
| registry-only payment MCP | REGISTRY_CANDIDATE | I5 / 90 | UNKNOWN | none | 65 / REVIEW/QUALIFY, not active |

For protected high-criticality tools, preserve the high intrinsic criticality for reporting but surface them in a separate **PROTECTED CRITICAL** bucket rather than treating them as an unprotected remediation gap.

## 13. User-facing Doctor output

`once doctor . --tools` should lead with actionability rather than a flat list:

```text
TOOL SAFETY PRIORITY

CRITICAL GAPS (I5)
  96  stripe/refunds.create       EXECUTED       QUALIFIED   UNPROTECTED
  94  aws/iam.detach_role_policy  MODEL_VISIBLE  QUALIFIED   UNPROTECTED

HIGH PRIORITY (I4)
  82  github/merge_pull_request   MODEL_VISIBLE  REVIEW      UNPROTECTED
  80  deploy_production           REGISTERED     QUALIFIED   UNPROTECTED

REVIEW (I2–I3)
  58  shell_exec                  MODEL_VISIBLE  UNKNOWN     DYNAMIC
  47  github/create_issue         CONFIGURED     REVIEW      UNPROTECTED

BYPASS / READ-ONLY
   4  github/get_file
   3  web/search
   2  weather/get

PROTECTED CRITICAL
  92  stripe/payment_intents.create   EXECUTED   ONCE PROTECTED
```

The developer should be able to understand the top safety gaps in seconds.

## 14. Machine behavior

Once should sort attention using this order:

1. `QUALIFIED` + unprotected + highest action priority
2. `REVIEW_REQUIRED`/`UNKNOWN` + highest criticality
3. protected critical tools that need health verification
4. observed moderate tools
5. configured/source-only tools
6. read-only/bypass tools
7. registry candidates

This prioritization is explainable, deterministic, and compatible with the existing Once safety model.

## 15. Safety invariants

- Importance never grants permission to execute.
- Discovery never launches unknown local servers automatically.
- Classification never exposes secret arguments.
- `UNKNOWN` never becomes `READ_ONLY` merely because no mutation was detected.
- MCP annotations are evidence, not unquestionable truth.
- Runtime evidence can increase confidence/exposure, but cannot by itself prove duplicate safety.
- Native idempotency reduces remediation urgency but does not automatically replace provider-truth analysis.
- The Once four-condition test remains the gate for protection.
- Fail-closed semantics apply only after a supported operation is actually under Once protection.
