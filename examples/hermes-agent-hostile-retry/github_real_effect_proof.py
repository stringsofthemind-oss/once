from __future__ import annotations

"""One-shot real external-effect proof for Once through pinned Hermes middleware.

This script is intentionally run only from the dedicated proof workflow. It creates
one disposable GitHub issue in the Once repository, deliberately discards the
successful provider acknowledgement after GitHub returns 201, and then proves:

- Once records UNKNOWN instead of authorizing a blind retry;
- Hermes' fail-open middleware does not bypass the Once short-circuit;
- temporary provider read-after-write invisibility remains UNKNOWN, never ABSENT;
- a fresh OnceCore using the same durable SQLite state reconciles GitHub truth;
- replay with a different transport/tool-call ID does not create a second issue;
- semantic drift conflicts before dispatch; and
- exactly one externally observable issue exists for the proof marker.

The created issue is closed in cleanup but remains externally observable evidence.
"""

import json
import os
import sys
import tempfile
import time
import types
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from once_agent.core import OnceCore, OperationState, ProviderTruth
from once_agent.hermes import HermesLookupResult, make_hermes_tool_execution_middleware
from once_agent.storage.sqlite import SQLiteOperationStore


EXPECTED_HERMES_COMMIT = "ea81748579ee1732d214ccb75f91d22208ed623d"
API_VERSION = "2022-11-28"
VISIBILITY_TIMEOUT_SECONDS = 30.0
VISIBILITY_POLL_SECONDS = 1.0


class _Manager:
    def __init__(self) -> None:
        self._middleware = {}
        self.failures = []

    def _report_hook_failure(self, kind, callback, call_kwargs, exc, *, surface):
        del call_kwargs
        self.failures.append(
            {
                "kind": kind,
                "callback": getattr(callback, "__name__", repr(callback)),
                "error": type(exc).__name__,
                "surface": surface,
            }
        )


def _headers(token: str) -> dict[str, str]:
    return {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
        "X-GitHub-Api-Version": API_VERSION,
        "User-Agent": "once-hermes-real-effect-proof",
        "Cache-Control": "no-cache",
    }


def _request_json(
    token: str,
    url: str,
    *,
    method: str = "GET",
    payload: dict[str, Any] | None = None,
) -> tuple[int, Any]:
    data = None
    headers = _headers(token)
    if payload is not None:
        data = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, method=method, headers=headers)
    with urllib.request.urlopen(request, timeout=30) as response:
        body = response.read()
        parsed = json.loads(body.decode("utf-8")) if body else None
        return int(response.status), parsed


class GitHubIssueEffect:
    """Deliberately non-idempotent GitHub issue creation plus read-only reconciliation."""

    def __init__(self, *, token: str, repository: str, marker: str) -> None:
        self.token = token
        self.repository = repository
        self.marker = marker
        self.terminal_calls = 0
        self.visibility_zero_reads = 0

    @property
    def issues_url(self) -> str:
        return f"https://api.github.com/repos/{self.repository}/issues"

    def terminal(self, args: dict[str, Any]) -> dict[str, Any]:
        self.terminal_calls += 1
        status, _created = _request_json(
            self.token,
            self.issues_url,
            method="POST",
            payload={
                "title": args["title"],
                "body": args["body"],
            },
        )
        if status != 201:
            raise RuntimeError(f"GitHub issue creation returned unexpected HTTP {status}")

        # Deliberately discard the successful acknowledgement/result after the
        # real provider committed the issue. The callback reports failure to its
        # caller even though GitHub has already accepted the mutation.
        raise RuntimeError("deliberately discarded GitHub 201 acknowledgement after commit")

    def matching_issues_once(self) -> list[dict[str, Any]]:
        matches: list[dict[str, Any]] = []
        for page in range(1, 6):
            query = urllib.parse.urlencode(
                {
                    "state": "all",
                    "per_page": 100,
                    "page": page,
                    "sort": "created",
                    "direction": "desc",
                }
            )
            status, rows = _request_json(self.token, f"{self.issues_url}?{query}")
            if status != 200 or not isinstance(rows, list):
                raise RuntimeError("GitHub issue lookup did not return a list")
            for row in rows:
                if not isinstance(row, dict) or "pull_request" in row:
                    continue
                title = str(row.get("title") or "")
                body = str(row.get("body") or "")
                if self.marker in title or self.marker in body:
                    matches.append(row)
            if len(rows) < 100:
                break
        return matches

    def wait_for_matching_issues(self, *, timeout_seconds: float = VISIBILITY_TIMEOUT_SECONDS) -> list[dict[str, Any]]:
        """Wait only for read visibility; never interpret zero matches as ABSENT."""

        deadline = time.monotonic() + max(timeout_seconds, 0.0)
        while True:
            matches = self.matching_issues_once()
            if matches:
                return matches
            self.visibility_zero_reads += 1
            if time.monotonic() >= deadline:
                return []
            time.sleep(VISIBILITY_POLL_SECONDS)

    def reconcile(self, operation_id, action_fingerprint, args, context):
        del operation_id, action_fingerprint, args, context
        matches = self.wait_for_matching_issues()
        if len(matches) != 1:
            # Crucially, temporary lack of read evidence is UNKNOWN. It never
            # becomes ABSENT and therefore never authorizes redispatch.
            return HermesLookupResult(ProviderTruth.UNKNOWN)
        issue = matches[0]
        return HermesLookupResult(
            ProviderTruth.CONFIRMED,
            {
                "issue_number": int(issue["number"]),
                "html_url": str(issue["html_url"]),
                "marker": self.marker,
            },
        )

    def close_matching_issues(self) -> None:
        for issue in self.wait_for_matching_issues():
            number = int(issue["number"])
            _request_json(
                self.token,
                f"{self.issues_url}/{number}",
                method="PATCH",
                payload={"state": "closed"},
            )


def operation_id(tool_name, args, context):
    del context
    if tool_name != "create_github_issue":
        return None
    return f"create-github-issue:{args['intent_id']}"


def block_code(value: Any) -> str:
    parsed = json.loads(value)
    assert parsed["ok"] is False
    return str(parsed["code"])


def load_pinned_hermes(checkout: Path):
    if not (checkout / ".git" / "HEAD").exists():
        raise AssertionError("Hermes checkout has no .git/HEAD")

    sys.path.insert(0, str(checkout))
    import hermes_cli.middleware as hermes_middleware  # type: ignore

    manager = _Manager()
    plugins_stub = types.ModuleType("hermes_cli.plugins")
    plugins_stub._delivery_manager = lambda: manager
    sys.modules["hermes_cli.plugins"] = plugins_stub
    return hermes_middleware, manager


def invoke(hermes_middleware, manager, callback, terminal, *, tool_name, args, **context):
    manager._middleware = {"tool_execution": [callback]}
    return hermes_middleware.run_tool_execution_middleware(
        tool_name,
        dict(args),
        terminal,
        original_args=dict(args),
        **context,
    )


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: github_real_effect_proof.py PATH_TO_PINNED_HERMES_CHECKOUT")

    token = os.environ.get("GITHUB_TOKEN")
    repository = os.environ.get("GITHUB_REPOSITORY")
    run_id = os.environ.get("GITHUB_RUN_ID")
    run_attempt = os.environ.get("GITHUB_RUN_ATTEMPT", "1")
    if not token or not repository or not run_id:
        raise SystemExit("GITHUB_TOKEN, GITHUB_REPOSITORY and GITHUB_RUN_ID are required")

    marker = f"once-hermes-real-effect-{run_id}-attempt-{run_attempt}"
    checkout = Path(sys.argv[1]).resolve()
    hermes_middleware, manager = load_pinned_hermes(checkout)
    effect = GitHubIssueEffect(token=token, repository=repository, marker=marker)

    title = f"[DISPOSABLE PROOF] Once + Hermes lost-ack safety — {marker}"
    body = (
        "Automated disposable execution-safety proof.\n\n"
        f"Marker: `{marker}`\n\n"
        "GitHub accepted this real issue creation, then the test deliberately discarded "
        "the successful acknowledgement before returning to Once. The proof subsequently "
        "reconciles provider truth and verifies that no duplicate issue is created."
    )
    args = {
        "intent_id": marker,
        "title": title,
        "body": body,
    }
    logical_id = f"create-github-issue:{marker}"

    # This marker is unique to one workflow attempt. Refuse to start if an issue
    # already exists, so the initial state is unambiguous. A single snapshot is
    # enough here because the marker has never previously been used.
    before = effect.matching_issues_once()
    if before:
        raise AssertionError(f"proof marker already exists before execution: {marker}")

    try:
        with tempfile.TemporaryDirectory() as td:
            state_path = Path(td) / "once-hermes-real-effect.sqlite"

            core1 = OnceCore(SQLiteOperationStore(state_path), lease_ms=60_000)
            middleware1 = make_hermes_tool_execution_middleware(
                core=core1,
                operation_id=operation_id,
                reconcile=effect.reconcile,
            )

            # Real external commit + deliberately discarded successful ack.
            first = invoke(
                hermes_middleware,
                manager,
                middleware1,
                effect.terminal,
                tool_name="create_github_issue",
                args=args,
                session_id="real-proof-session",
                task_id=f"real-proof-task:{marker}",
                turn_id="turn-before-restart",
                tool_call_id="transport-call-before-restart",
            )
            assert block_code(first) == "once_outcome_unknown"
            assert effect.terminal_calls == 1
            stored = SQLiteOperationStore(state_path).get(logical_id)
            assert stored is not None and stored.state == OperationState.UNKNOWN

            # GitHub can briefly return a stale issue-list view immediately
            # after a successful 201. Wait only for visibility; zero matches at
            # any instant remains uncertainty and cannot authorize another write.
            after_commit = effect.wait_for_matching_issues()
            assert len(after_commit) == 1, (
                "expected exactly one real GitHub issue after provider visibility window; "
                f"found {len(after_commit)}"
            )

            # Fresh process-equivalent OnceCore over the same durable state.
            core2 = OnceCore(SQLiteOperationStore(state_path), lease_ms=60_000)
            middleware2 = make_hermes_tool_execution_middleware(
                core=core2,
                operation_id=operation_id,
                reconcile=effect.reconcile,
            )
            recovered = invoke(
                hermes_middleware,
                manager,
                middleware2,
                effect.terminal,
                tool_name="create_github_issue",
                args=args,
                session_id="real-proof-session",
                task_id=f"real-proof-task:{marker}",
                turn_id="turn-after-restart",
                tool_call_id="different-transport-call-after-restart",
            )
            assert recovered["marker"] == marker
            assert effect.terminal_calls == 1, "reconciliation must not redispatch the issue create"
            stored_after = SQLiteOperationStore(state_path).get(logical_id)
            assert stored_after is not None and stored_after.state == OperationState.CONFIRMED

            # A subsequent replay with yet another transport ID returns the
            # reconciled result and must still avoid provider dispatch.
            replay = invoke(
                hermes_middleware,
                manager,
                middleware2,
                effect.terminal,
                tool_name="create_github_issue",
                args=args,
                session_id="real-proof-session",
                task_id=f"real-proof-task:{marker}",
                turn_id="turn-replay",
                tool_call_id="third-transport-call-id",
            )
            assert replay == recovered
            assert effect.terminal_calls == 1

            # Same logical identity with changed effect-bearing content conflicts
            # before dispatch.
            drifted = dict(args)
            drifted["title"] = title + " CHANGED"
            conflict = invoke(
                hermes_middleware,
                manager,
                middleware2,
                effect.terminal,
                tool_name="create_github_issue",
                args=drifted,
                session_id="real-proof-session",
                task_id=f"real-proof-task:{marker}",
                turn_id="turn-conflict",
                tool_call_id="transport-call-conflict",
            )
            assert block_code(conflict) == "once_operation_conflict"
            assert effect.terminal_calls == 1

            final_matches = effect.wait_for_matching_issues(timeout_seconds=5.0)
            assert len(final_matches) == 1, (
                "duplicate external effect detected: expected one matching GitHub issue, "
                f"found {len(final_matches)}"
            )
            issue = final_matches[0]

            print("PASS: real GitHub effect held at exactly one issue through pinned Hermes middleware")
            print(f"HERMES_PIN={EXPECTED_HERMES_COMMIT}")
            print(f"MARKER={marker}")
            print(f"ISSUE_NUMBER={issue['number']}")
            print(f"ISSUE_URL={issue['html_url']}")
            print("PROVIDER_COMMIT=GitHub issue creation returned HTTP 201")
            print("ACK=deliberately discarded before returning to Once")
            print("ONCE_AFTER_ACK_LOSS=UNKNOWN")
            print("TEMPORARY_ZERO_MATCH_READ=UNKNOWN_NOT_ABSENT")
            print(f"PROVIDER_VISIBILITY_ZERO_READS={effect.visibility_zero_reads}")
            print("RESTART_RECONCILIATION=CONFIRMED")
            print("TERMINAL_DISPATCH_COUNT=1")
            print("EXTERNAL_MATCHING_ISSUE_COUNT=1")
            print("SEMANTIC_DRIFT=CONFLICT_WITHOUT_DISPATCH")
    finally:
        # Close all marker-matching disposable issues even if an assertion fails.
        # Closed issues remain durable, externally inspectable proof artifacts.
        try:
            effect.close_matching_issues()
        except Exception as cleanup_exc:
            print(f"WARNING: disposable issue cleanup failed: {cleanup_exc}", file=sys.stderr)


if __name__ == "__main__":
    main()
