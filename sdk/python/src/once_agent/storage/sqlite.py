from __future__ import annotations

"""SQLite reference backend for the Once V4 framework-neutral core."""

import json
from pathlib import Path
import sqlite3
import time
from typing import Any, Callable, Mapping, Optional, Union

from ..core import (
    AcquireDisposition,
    AcquireResult,
    ConcurrentModification,
    ExecutionRightLost,
    ExecutionSource,
    OperationConflict,
    OperationRecord,
    OperationState,
)

class SQLiteOperationStore:
    """Durable single-host reference backend.

    Distributed backends should use a transactional shared store and datastore-authoritative
    time for lease decisions.
    """

    def __init__(self, path: Union[str, Path], *, now_ms: Optional[Callable[[], int]] = None) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._now_ms = now_ms or (lambda: time.time_ns() // 1_000_000)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, timeout=30, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=FULL")
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA busy_timeout=30000")
        return conn

    def _initialize(self) -> None:
        conn = self._connect()
        try:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS operations (
                    operation_id TEXT PRIMARY KEY,
                    action_fingerprint TEXT NOT NULL,
                    state TEXT NOT NULL CHECK (state IN ('CLAIMED','CONFIRMED','UNKNOWN')),
                    receipt_json TEXT,
                    owner_token TEXT,
                    lease_until_ms INTEGER,
                    fence_token INTEGER NOT NULL CHECK (fence_token >= 1),
                    version INTEGER NOT NULL CHECK (version >= 1),
                    created_at_ms INTEGER NOT NULL,
                    updated_at_ms INTEGER NOT NULL,
                    CHECK (
                        (state='CLAIMED' AND owner_token IS NOT NULL AND lease_until_ms IS NOT NULL AND receipt_json IS NULL)
                        OR (state='UNKNOWN' AND owner_token IS NULL AND lease_until_ms IS NULL AND receipt_json IS NULL)
                        OR (state='CONFIRMED' AND owner_token IS NULL AND lease_until_ms IS NULL AND receipt_json IS NOT NULL)
                    )
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS operation_events (
                    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    operation_id TEXT NOT NULL,
                    event_type TEXT NOT NULL,
                    from_state TEXT,
                    to_state TEXT,
                    owner_token TEXT,
                    fence_token INTEGER,
                    version INTEGER,
                    detail_json TEXT,
                    created_at_ms INTEGER NOT NULL
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_operation_events_operation ON operation_events(operation_id,event_id)"
            )
        finally:
            conn.close()

    @staticmethod
    def _row_to_record(row: sqlite3.Row) -> OperationRecord:
        return OperationRecord(
            operation_id=row["operation_id"],
            action_fingerprint=row["action_fingerprint"],
            state=OperationState(row["state"]),
            receipt=None if row["receipt_json"] is None else json.loads(row["receipt_json"]),
            owner_token=row["owner_token"],
            lease_until_ms=row["lease_until_ms"],
            fence_token=int(row["fence_token"]),
            version=int(row["version"]),
            created_at_ms=int(row["created_at_ms"]),
            updated_at_ms=int(row["updated_at_ms"]),
        )

    def _select(self, conn: sqlite3.Connection, operation_id: str) -> Optional[sqlite3.Row]:
        return conn.execute("SELECT * FROM operations WHERE operation_id=?", (operation_id,)).fetchone()

    def _event(self, conn: sqlite3.Connection, *, operation_id: str, event_type: str, record: Optional[OperationRecord] = None, from_state: Optional[OperationState] = None, to_state: Optional[OperationState] = None, detail: Optional[Mapping[str, Any]] = None, owner_token: Optional[str] = None, fence_token: Optional[int] = None, version: Optional[int] = None) -> None:
        conn.execute(
            """
            INSERT INTO operation_events(operation_id,event_type,from_state,to_state,owner_token,fence_token,version,detail_json,created_at_ms)
            VALUES(?,?,?,?,?,?,?,?,?)
            """,
            (
                operation_id,
                event_type,
                None if from_state is None else from_state.value,
                None if to_state is None else to_state.value,
                owner_token if owner_token is not None else (None if record is None else record.owner_token),
                fence_token if fence_token is not None else (None if record is None else record.fence_token),
                version if version is not None else (None if record is None else record.version),
                None if detail is None else json.dumps(dict(detail), sort_keys=True),
                self._now_ms(),
            ),
        )

    def append_event(self, *, operation_id: str, event_type: str, record: Optional[OperationRecord] = None, from_state: Optional[OperationState] = None, to_state: Optional[OperationState] = None, detail: Optional[Mapping[str, Any]] = None) -> None:
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            self._event(conn, operation_id=operation_id, event_type=event_type, record=record, from_state=from_state, to_state=to_state, detail=detail)
            conn.execute("COMMIT")
        except BaseException:
            if conn.in_transaction:
                conn.execute("ROLLBACK")
            raise
        finally:
            conn.close()

    def get(self, operation_id: str) -> Optional[OperationRecord]:
        conn = self._connect()
        try:
            row = self._select(conn, operation_id)
            return None if row is None else self._row_to_record(row)
        finally:
            conn.close()

    def acquire_or_observe(self, *, operation_id: str, action_fingerprint: str, owner_token: str, lease_ms: int) -> AcquireResult:
        if lease_ms <= 0:
            raise ValueError("lease_ms must be positive")
        now = self._now_ms()
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            row = self._select(conn, operation_id)
            if row is None:
                conn.execute(
                    """
                    INSERT INTO operations(operation_id,action_fingerprint,state,receipt_json,owner_token,lease_until_ms,fence_token,version,created_at_ms,updated_at_ms)
                    VALUES(?,?,'CLAIMED',NULL,?,?,1,1,?,?)
                    """,
                    (operation_id, action_fingerprint, owner_token, now + lease_ms, now, now),
                )
                rec = self._row_to_record(self._select(conn, operation_id))
                self._event(conn, operation_id=operation_id, event_type="CLAIM_ACQUIRED", record=rec, to_state=OperationState.CLAIMED)
                conn.execute("COMMIT")
                return AcquireResult(AcquireDisposition.ACQUIRED, rec)

            rec = self._row_to_record(row)
            if rec.action_fingerprint != action_fingerprint:
                self._event(conn, operation_id=operation_id, event_type="OPERATION_CONFLICT", record=rec, from_state=rec.state, to_state=rec.state, detail={"stored_fingerprint": rec.action_fingerprint, "requested_fingerprint": action_fingerprint})
                conn.execute("COMMIT")
                raise OperationConflict(f"operation_id {operation_id!r} is bound to different semantic content")

            if rec.state == OperationState.CONFIRMED:
                conn.execute("COMMIT")
                return AcquireResult(AcquireDisposition.REPLAY, rec)

            if rec.state == OperationState.CLAIMED and rec.lease_until_ms is not None and now < rec.lease_until_ms:
                self._event(conn, operation_id=operation_id, event_type="IN_FLIGHT_BLOCKED", record=rec, from_state=rec.state, to_state=rec.state)
                conn.execute("COMMIT")
                return AcquireResult(AcquireDisposition.IN_FLIGHT, rec)

            conn.execute("COMMIT")
            return AcquireResult(AcquireDisposition.RECONCILE, rec)
        except BaseException:
            if conn.in_transaction:
                conn.execute("ROLLBACK")
            raise
        finally:
            conn.close()

    def reacquire_after_absent(self, *, operation_id: str, action_fingerprint: str, expected_version: int, owner_token: str, lease_ms: int) -> OperationRecord:
        now = self._now_ms()
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            cur = conn.execute(
                """
                UPDATE operations SET state='CLAIMED',receipt_json=NULL,owner_token=?,lease_until_ms=?,
                    fence_token=fence_token+1,version=version+1,updated_at_ms=?
                WHERE operation_id=? AND action_fingerprint=? AND version=? AND state IN ('CLAIMED','UNKNOWN')
                """,
                (owner_token, now + lease_ms, now, operation_id, action_fingerprint, expected_version),
            )
            if cur.rowcount != 1:
                conn.execute("ROLLBACK")
                raise ConcurrentModification("operation changed before reacquisition")
            rec = self._row_to_record(self._select(conn, operation_id))
            self._event(conn, operation_id=operation_id, event_type="CLAIM_REACQUIRED", record=rec, to_state=OperationState.CLAIMED, detail={"reason": "authoritative_provider_absence"})
            conn.execute("COMMIT")
            return rec
        except BaseException:
            if conn.in_transaction:
                conn.execute("ROLLBACK")
            raise
        finally:
            conn.close()

    def renew_claim(self, *, operation_id: str, action_fingerprint: str, expected_version: int, owner_token: str, fence_token: int, lease_ms: int) -> OperationRecord:
        if lease_ms <= 0:
            raise ValueError("lease_ms must be positive")
        now = self._now_ms()
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            cur = conn.execute(
                """
                UPDATE operations SET lease_until_ms=?,version=version+1,updated_at_ms=?
                WHERE operation_id=? AND action_fingerprint=? AND state='CLAIMED'
                    AND owner_token=? AND fence_token=? AND version=? AND lease_until_ms>?
                """,
                (now + lease_ms, now, operation_id, action_fingerprint, owner_token, fence_token, expected_version, now),
            )
            if cur.rowcount != 1:
                conn.execute("ROLLBACK")
                raise ExecutionRightLost("claim could not be renewed; ownership or lease was lost")
            rec = self._row_to_record(self._select(conn, operation_id))
            self._event(conn, operation_id=operation_id, event_type="CLAIM_RENEWED", record=rec, from_state=OperationState.CLAIMED, to_state=OperationState.CLAIMED)
            conn.execute("COMMIT")
            return rec
        except BaseException:
            if conn.in_transaction:
                conn.execute("ROLLBACK")
            raise
        finally:
            conn.close()

    def assert_execution_right(self, *, operation_id: str, action_fingerprint: str, expected_version: int, owner_token: str, fence_token: int) -> OperationRecord:
        now = self._now_ms()
        conn = self._connect()
        try:
            row = conn.execute(
                """
                SELECT * FROM operations WHERE operation_id=? AND action_fingerprint=? AND state='CLAIMED'
                    AND owner_token=? AND fence_token=? AND version=? AND lease_until_ms>?
                """,
                (operation_id, action_fingerprint, owner_token, fence_token, expected_version, now),
            ).fetchone()
            if row is None:
                raise ExecutionRightLost("execution right is no longer current")
            return self._row_to_record(row)
        finally:
            conn.close()

    def mark_unknown(self, *, operation_id: str, action_fingerprint: str, expected_version: int, detail: Optional[Mapping[str, Any]] = None) -> OperationRecord:
        now = self._now_ms()
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            before_row = self._select(conn, operation_id)
            if before_row is None:
                conn.execute("ROLLBACK")
                raise ConcurrentModification("operation no longer exists")
            before = self._row_to_record(before_row)
            if before.action_fingerprint != action_fingerprint:
                conn.execute("ROLLBACK")
                raise OperationConflict("operation semantic fingerprint changed")
            cur = conn.execute(
                """
                UPDATE operations SET state='UNKNOWN',receipt_json=NULL,owner_token=NULL,lease_until_ms=NULL,
                    version=version+1,updated_at_ms=?
                WHERE operation_id=? AND action_fingerprint=? AND version=? AND state IN ('CLAIMED','UNKNOWN')
                """,
                (now, operation_id, action_fingerprint, expected_version),
            )
            if cur.rowcount != 1:
                conn.execute("ROLLBACK")
                raise ConcurrentModification("operation changed before UNKNOWN persisted")
            rec = self._row_to_record(self._select(conn, operation_id))
            self._event(conn, operation_id=operation_id, event_type="OUTCOME_UNKNOWN", record=rec, from_state=before.state, to_state=OperationState.UNKNOWN, detail=detail, owner_token=before.owner_token, fence_token=before.fence_token, version=rec.version)
            conn.execute("COMMIT")
            return rec
        except BaseException:
            if conn.in_transaction:
                conn.execute("ROLLBACK")
            raise
        finally:
            conn.close()

    def confirm(self, *, operation_id: str, action_fingerprint: str, receipt: Mapping[str, Any], expected_version: int, source: ExecutionSource, owner_token: Optional[str] = None, fence_token: Optional[int] = None) -> OperationRecord:
        now = self._now_ms()
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            before_row = self._select(conn, operation_id)
            if before_row is None:
                conn.execute("ROLLBACK")
                raise ConcurrentModification("operation no longer exists")
            before = self._row_to_record(before_row)
            if before.action_fingerprint != action_fingerprint:
                conn.execute("ROLLBACK")
                raise OperationConflict("operation semantic fingerprint changed")

            extra = ""
            params: list[Any] = [operation_id, action_fingerprint, expected_version]
            if source == ExecutionSource.EXECUTED:
                if owner_token is None or fence_token is None:
                    raise ValueError("EXECUTED confirmation requires owner_token and fence_token")
                extra = " AND state='CLAIMED' AND owner_token=? AND fence_token=?"
                params.extend([owner_token, fence_token])

            cur = conn.execute(
                f"""
                UPDATE operations SET state='CONFIRMED',receipt_json=?,owner_token=NULL,lease_until_ms=NULL,
                    version=version+1,updated_at_ms=?
                WHERE operation_id=? AND action_fingerprint=? AND version=? AND state IN ('CLAIMED','UNKNOWN'){extra}
                """,
                [json.dumps(dict(receipt), sort_keys=True), now, *params],
            )
            if cur.rowcount != 1:
                conn.execute("ROLLBACK")
                if source == ExecutionSource.EXECUTED:
                    raise ExecutionRightLost("provider returned after execution ownership changed")
                raise ConcurrentModification("operation changed before reconciliation confirmation")
            rec = self._row_to_record(self._select(conn, operation_id))
            self._event(conn, operation_id=operation_id, event_type="EXECUTE_CONFIRMED" if source == ExecutionSource.EXECUTED else "RECONCILE_CONFIRMED", record=rec, from_state=before.state, to_state=OperationState.CONFIRMED, detail={"source": source.value}, owner_token=before.owner_token, fence_token=before.fence_token, version=rec.version)
            conn.execute("COMMIT")
            return rec
        except BaseException:
            if conn.in_transaction:
                conn.execute("ROLLBACK")
            raise
        finally:
            conn.close()

    def list_events(self, operation_id: str) -> list[dict[str, Any]]:
        conn = self._connect()
        try:
            rows = conn.execute("SELECT * FROM operation_events WHERE operation_id=? ORDER BY event_id", (operation_id,)).fetchall()
            out = []
            for row in rows:
                item = dict(row)
                item["detail"] = None if item["detail_json"] is None else json.loads(item["detail_json"])
                item.pop("detail_json")
                out.append(item)
            return out
        finally:
            conn.close()


