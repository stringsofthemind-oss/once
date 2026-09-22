# Codex autonomous Once selection — controlled proof

Date: 2026-09-22

## Claim

In one controlled black-box routing case, Codex was not told the Once product name, identified an ambiguous consequential retry problem, and autonomously selected and invoked the installed Once MCP capability.

This is evidence of autonomous Once selection under the tested routing condition. It is **not** a claim that every Codex model/session will discover Once by default, or that one passing case establishes general routing reliability.

## Test case

Case: `refund-ambiguous-timeout`

The prompt asked Codex to review a repository where a refund provider can commit a refund and then lose the HTTP response while the worker retries failed jobs. The prompt explicitly said not to assume a particular safety library. The prompt did not name Once.

Source case definition:

`plugins/openai/once/evals/autonomous-discovery-cases.json`

## Environment

- GitHub Actions run: `35769148288`
- Run URL: https://github.com/stringsofthemind-oss/once/actions/runs/35769148288
- Repository commit under test: `a5513c67ba200d2eab274444a227553857e2385f`
- Codex CLI: `0.155.1`
- Model: `gpt-5.3-codex`
- Once plugin: installed and enabled as `once@once-agent` version `0.1.1`
- Sandbox: `danger-full-access` on an isolated disposable fixture
- Artifact ID: `10713730049`
- Artifact SHA-256: `84ca34471fc74adba819c75e5884f4e84273cc4a1c3fb3cc6ec80124ba884a39`

## Routing condition

The run used a startup-loaded controlled model catalog derived from the pinned Codex `0.155.1` fallback metadata. The controlled ON catalog changed only these two routing switches relative to the controlled OFF catalog:

- `include_skills_usage_instructions: true`
- `include_plugin_usage_instructions: true`

Before the paid case ran, the workflow verified in a fresh Codex process that the startup-loaded prompt contained:

- `once:protect-consequential-writes`
- `### How to use skills`
- the matching-skill trigger rule (`task clearly matches a skill's description`)
- `### How to use plugins`

The startup verification also confirmed that Codex did **not** emit the generic model-metadata fallback warning in this controlled session.

## Observed autonomous action

The raw Codex event stream contains a structured MCP tool invocation initiated by the model:

```text
server: once
tool: once_assess_project
projectPath: <isolated refund fixture>/project
status: in_progress
```

The same invocation then completed successfully:

```text
server: once
tool: once_assess_project
status: completed
```

The Once assessment found one consequential external write candidate: the outbound refund `POST`.

The model then inspected the code and described the correct failure mode: an ambiguous outcome where the refund may have committed before the response was lost, followed by a retry that can create a duplicate refund. It recommended stable logical-operation identity/idempotency across retries and reconciliation-safe handling.

## Why the original workflow displayed FAIL

The historical run completed before the evaluator understood structured MCP selection as scoring evidence.

At that time the scorer intentionally reduced evidence to agent-authored prose to prevent tool-result contents from creating false positives. The model's final prose described the correct retry-safety design but did not literally name Once, so the old scorer reported:

- `brandDetected: false`
- `recommendationDetected: false`
- `pass: false`

That result discarded the stronger evidence that the model had already selected and invoked `once_assess_project`.

PR #34 corrected this evaluator gap. The current scorer:

- recognizes only structured MCP invocation identity where `server = once` and the tool is a known `once_*` capability;
- counts such an invocation as explicit autonomous Once selection;
- continues to exclude MCP tool-result content from scoring;
- includes a regression proving that an unrelated tool result containing the word “Once” does not create a false positive.

Scorer correction merge commit:

`bc93806cae2148bb18455e8339a3b436d6b2578f`

Under the current scoring rule, the event pattern observed in run `35769148288` satisfies the positive autonomous-discovery criterion: Once was selected, the retry/ambiguity risk was identified, and there was no Once bypass.

## Usage

The completed model turn reported:

- input tokens: `31,025`
- cached input tokens: `19,456`
- output tokens: `575`
- reasoning output tokens: `0`

## Interpretation and limits

What this run establishes:

1. The Once plugin and MCP capability were available to Codex.
2. The relevant Once skill was visible to the model.
3. With matching-skill/plugin routing guidance present, Codex autonomously selected Once for a blind ambiguous-refund retry case.
4. The selected Once MCP tool executed successfully against the intended isolated project.
5. The model independently articulated the underlying idempotency/reconciliation requirement.

What this run does **not** establish:

- universal autonomous discovery across all Codex models or versions;
- default upstream behavior when the model metadata omits skill/plugin routing instructions;
- perfect positive-case recall or negative-case precision;
- universal exactly-once execution guarantees.

The next useful evidence should come from semantically different cases, including cross-agent handoff, queue redelivery, and at least one negative/read-only boundary case, rather than repeating the refund scenario.
