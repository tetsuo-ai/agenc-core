"""Durable operational receipts. AgenC remains the sole canonical run writer."""

from __future__ import annotations

import hashlib
import re
import secrets
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any
from task_files import has_file

from protocol import HostError, bounded_identity, decode_json, encode_json, operation_index


class LeaseStore:
    def __init__(self, path: Path):
        self.lock = threading.RLock()
        self.db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.executescript("""
          CREATE TABLE IF NOT EXISTS environments (
            generation TEXT PRIMARY KEY, container_id TEXT NOT NULL,
            binding BLOB NOT NULL, status TEXT NOT NULL, reason TEXT
          );
          CREATE TABLE IF NOT EXISTS operations (
            id TEXT PRIMARY KEY, token_hash TEXT NOT NULL,
            generation TEXT NOT NULL, principal INTEGER NOT NULL, owner TEXT NOT NULL,
            run_id TEXT NOT NULL, call_id TEXT NOT NULL, attempt INTEGER NOT NULL,
            authority_revision INTEGER NOT NULL, spec BLOB NOT NULL,
            state TEXT NOT NULL, scope BLOB NOT NULL, detached INTEGER NOT NULL,
            created_at INTEGER NOT NULL, runtime_pid INTEGER, exec_id TEXT,
            runtime_exit INTEGER, leader_exited INTEGER NOT NULL DEFAULT 0,
            output_complete INTEGER NOT NULL DEFAULT 0,
            cleanup_proven INTEGER NOT NULL DEFAULT 0, failure TEXT,
            operation_index INTEGER NOT NULL DEFAULT 0,
            UNIQUE(generation, principal, owner, run_id, call_id, attempt, operation_index)
          );
          CREATE TABLE IF NOT EXISTS authorities (
            principal INTEGER NOT NULL, owner TEXT NOT NULL,
            generation TEXT NOT NULL, revision INTEGER NOT NULL,
            PRIMARY KEY(principal, owner)
          );
          CREATE TABLE IF NOT EXISTS receipts (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL,
            kind TEXT NOT NULL, payload BLOB NOT NULL, at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS receipts_operation_kind ON receipts(operation_id,kind,sequence);
          CREATE TABLE IF NOT EXISTS inputs (
            operation_id TEXT NOT NULL, input_id TEXT NOT NULL, digest TEXT NOT NULL,
            state TEXT NOT NULL, PRIMARY KEY(operation_id,input_id)
          );
          CREATE TABLE IF NOT EXISTS filesystem_effects (
            id TEXT PRIMARY KEY, generation TEXT NOT NULL, principal INTEGER NOT NULL,
            owner TEXT NOT NULL, run_id TEXT NOT NULL, call_id TEXT NOT NULL, attempt INTEGER NOT NULL,
            digest TEXT NOT NULL, state TEXT NOT NULL, result BLOB,
            operation_index INTEGER NOT NULL DEFAULT 0,
            UNIQUE(generation,principal,owner,run_id,call_id,attempt,operation_index)
          );
          CREATE TABLE IF NOT EXISTS output_frames (
            operation_id TEXT NOT NULL, offset INTEGER NOT NULL,
            length INTEGER NOT NULL, stream INTEGER NOT NULL,
            PRIMARY KEY(operation_id,offset)
          );
        """)
        columns = {row[1] for row in self.db.execute("PRAGMA table_info(operations)")}
        if "exit_code" not in columns:
            self.db.execute("ALTER TABLE operations ADD COLUMN exit_code INTEGER")
        if "residual_processes_terminated" not in columns:
            self.db.execute("ALTER TABLE operations ADD COLUMN residual_processes_terminated INTEGER NOT NULL DEFAULT 0")
        for name, kind in (("leader_pid", "INTEGER"), ("leader_start_time", "TEXT"), ("task_pid", "INTEGER")):
            if name not in columns:
                self.db.execute(f"ALTER TABLE operations ADD COLUMN {name} {kind}")
        self.db.execute("CREATE TABLE IF NOT EXISTS detached_startups (operation_id TEXT PRIMARY KEY, "
                        "state TEXT NOT NULL, task_pid INTEGER, peer_pid INTEGER, log_dev TEXT, log_ino TEXT, "
                        "log_mode INTEGER, error TEXT)")
        if "mirrored_length" not in {row[1] for row in self.db.execute("PRAGMA table_info(detached_startups)")}:
            self.db.execute("ALTER TABLE detached_startups ADD COLUMN mirrored_length INTEGER NOT NULL DEFAULT 0")
        authority_columns = {row[1] for row in self.db.execute("PRAGMA table_info(authorities)")}
        if "closed" not in authority_columns:
            self.db.execute("ALTER TABLE authorities ADD COLUMN closed INTEGER NOT NULL DEFAULT 0")
        for table in ("operations", "filesystem_effects"):
            self._upgrade_operation_indexes(table)
        self._upgrade_process_handles()

    def _upgrade_process_handles(self) -> None:
        """Allocate once in the receipt transaction; never reuse a retired number."""
        self.db.execute("BEGIN IMMEDIATE")
        try:
            existing = self.db.execute("SELECT name FROM sqlite_master WHERE name='process_handles'").fetchone()
            self.db.execute("CREATE TABLE IF NOT EXISTS process_handles ("
                            "session_id INTEGER PRIMARY KEY AUTOINCREMENT CHECK(session_id BETWEEN 1 AND 9007199254740991),"
                            "operation_id TEXT UNIQUE NOT NULL)")
            self.db.execute("CREATE TABLE IF NOT EXISTS execution_host_metadata (name TEXT PRIMARY KEY, value TEXT NOT NULL)")
            if existing is None:
                self.db.execute("INSERT INTO execution_host_metadata VALUES('process_handle_namespace',?)", (secrets.token_hex(16),))
                self.db.execute("INSERT INTO process_handles(operation_id) SELECT id FROM operations ORDER BY created_at,id")
            namespace = self.db.execute("SELECT value FROM execution_host_metadata WHERE name='process_handle_namespace'").fetchone()
            missing = self.db.execute("SELECT 1 FROM operations o LEFT JOIN process_handles h ON h.operation_id=o.id "
                                      "WHERE h.session_id IS NULL LIMIT 1").fetchone()
            if namespace is None or re.fullmatch(r"[a-f0-9]{32}", namespace[0]) is None or missing is not None:
                raise HostError("receipt_schema", "Original process handle identities are unavailable")
            self.process_handle_namespace = namespace[0]
            self.db.execute("COMMIT")
        except BaseException:
            self.db.execute("ROLLBACK")
            raise

    def _upgrade_operation_indexes(self, table: str) -> None:
        """Atomically retain old receipts at index zero while widening uniqueness."""
        if table not in ("operations", "filesystem_effects"):
            raise ValueError("Unknown operational table")
        if "operation_index" in {row[1] for row in self.db.execute(f"PRAGMA table_info({table})")}:
            return
        self.db.execute("BEGIN IMMEDIATE")
        try:
            self.db.execute(f"ALTER TABLE {table} ADD COLUMN operation_index INTEGER NOT NULL DEFAULT 0")
            schema = self.db.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone()[0]
            schema, count = re.subn(r"UNIQUE\s*\(generation\s*,\s*principal\s*,\s*owner\s*,\s*run_id\s*,\s*call_id\s*,\s*attempt\s*\)",
                                    "UNIQUE(generation,principal,owner,run_id,call_id,attempt,operation_index)", schema)
            if count != 1:
                raise HostError("receipt_schema", "Operational receipt uniqueness could not be migrated")
            temporary = table + "_coordinate_upgrade"
            schema, count = re.subn(r"^CREATE TABLE\s+" + table + r"\b", "CREATE TABLE " + temporary, schema, count=1)
            if count != 1:
                raise HostError("receipt_schema", "Operational table identity could not be migrated")
            self.db.execute(schema)
            self.db.execute(f"INSERT INTO {temporary} SELECT * FROM {table}")
            self.db.execute(f"DROP TABLE {table}")
            self.db.execute(f"ALTER TABLE {temporary} RENAME TO {table}")
            self.db.execute("COMMIT")
        except BaseException:
            self.db.execute("ROLLBACK")
            raise

    def _receipt(self, operation: str, kind: str, payload: dict[str, Any]) -> None:
        self.db.execute("INSERT INTO receipts(operation_id,kind,payload,at) VALUES(?,?,?,?)",
                        (operation, kind, encode_json(payload), time.time_ns() // 1000000))

    def register_environment(self, binding: dict[str, Any]) -> None:
        encoded = encode_json(binding)
        with self.lock:
            row = self.db.execute("SELECT binding,status FROM environments WHERE generation=?",
                                  (binding["generation"],)).fetchone()
            if row is not None:
                if row["binding"] != encoded or row["status"] != "ready":
                    raise HostError("environment_unavailable", "Environment binding cannot be replaced")
                return
            self.db.execute("INSERT INTO environments VALUES(?,?,?,'ready',NULL)",
                            (binding["generation"], binding["containerId"], encoded))

    def environment(self, generation: str, require_ready: bool = True) -> dict[str, Any]:
        with self.lock:
            row = self.db.execute("SELECT * FROM environments WHERE generation=?", (generation,)).fetchone()
            if row is None or (require_ready and row["status"] != "ready"):
                raise HostError("environment_unavailable", "Environment generation is unavailable")
            return decode_json(row["binding"])

    def quarantine(self, generation: str, reason: str) -> None:
        with self.lock:
            self.db.execute("UPDATE environments SET status='quarantined',reason=? WHERE generation=?",
                            (reason, generation))

    def authorize(self, principal: int, owner: str, generation: str, revision: int) -> None:
        """Called only after the containment layer drains the previous revision."""
        if type(revision) is not int or revision < 0:
            raise HostError("invalid_authority", "Authority revision must be nonnegative")
        with self.lock:
            self.environment(generation)
            row = self.db.execute("SELECT * FROM authorities WHERE principal=? AND owner=?",
                                  (principal, owner)).fetchone()
            if row is not None:
                if row["generation"] != generation or revision < row["revision"]:
                    raise HostError("invalid_authority", "Session execution authority cannot be replaced or rolled back")
                if revision == row["revision"]:
                    if row["closed"]:
                        raise HostError("invalid_authority", "Closed execution authority requires a new revision")
                    return
                live = self.db.execute("SELECT id FROM operations WHERE principal=? AND owner=? "
                                       "AND cleanup_proven=0 AND detached=0 LIMIT 1",
                                       (principal, owner)).fetchone()
                if live is not None:
                    raise HostError("cleanup_unproven", "Previous execution authority has not drained")
                self.db.execute("UPDATE authorities SET revision=?,closed=0 WHERE principal=? AND owner=?",
                                (revision, principal, owner))
            else:
                self.db.execute("INSERT INTO authorities(principal,owner,generation,revision) VALUES(?,?,?,?)",
                                (principal, owner, generation, revision))

    def assert_authority(self, principal: int, owner: str, generation: str, revision: int) -> None:
        with self.lock:
            row = self.db.execute("SELECT * FROM authorities WHERE principal=? AND owner=?",
                                  (principal, owner)).fetchone()
            if row is None or row["generation"] != generation or row["revision"] != revision or row["closed"]:
                raise HostError("invalid_authority", "Execution authority revision is stale or unregistered")

    def allocate(self, *, generation: str, principal: int, owner: str, run_id: str,
                 call_id: str, attempt: int, authority_revision: int, spec: dict[str, Any],
                 scope: dict[str, Any], detached: bool, operation_id: str,
                 index: int = 0) -> tuple[str, str]:
        index = operation_index(index)
        with self.lock:
            self.environment(generation)
            self.assert_authority(principal, owner, generation, authority_revision)
            token = secrets.token_hex(32)
            self.db.execute("BEGIN IMMEDIATE")
            try:
                self.db.execute("""INSERT INTO operations
                  (id,token_hash,generation,principal,owner,run_id,call_id,attempt,
                   authority_revision,spec,state,scope,detached,created_at,operation_index)
                  VALUES(?,?,?,?,?,?,?,?,?,?,'allocated',?,?,?,?)""",
                                (operation_id, hashlib.sha256(token.encode()).hexdigest(), generation,
                                 principal, owner, run_id, call_id, attempt, authority_revision,
                                 encode_json(spec), encode_json(scope), int(detached),
                                 time.time_ns() // 1000000, index))
                last = self.db.execute("SELECT seq FROM sqlite_sequence WHERE name='process_handles'").fetchone()
                if last is not None and last[0] >= 9007199254740991:
                    raise HostError("process_limit", "Persistent numeric process handle space is exhausted")
                handle = self.db.execute("INSERT INTO process_handles(operation_id) VALUES(?)", (operation_id,)).lastrowid
                self._receipt(operation_id, "allocated", {"sessionId": handle})
                self.db.execute("COMMIT")
            except sqlite3.IntegrityError as error:
                self.db.execute("ROLLBACK")
                raise HostError("operation_exists", "Inspect the original operation; execution is never repeated") from error
            except BaseException:
                self.db.execute("ROLLBACK")
                raise
            return operation_id, f"{operation_id}.{token}"

    def operation(self, operation: str, principal: int | None = None,
                  owner: str | None = None) -> dict[str, Any]:
        with self.lock:
            row = self.db.execute("SELECT o.*,h.session_id FROM operations o LEFT JOIN process_handles h "
                                  "ON h.operation_id=o.id WHERE o.id=?", (operation,)).fetchone()
            if row is None:
                raise HostError("unknown_operation", "Unknown execution handle")
            if principal is not None and (principal != row["principal"] or owner != row["owner"]):
                raise HostError("owner_denied", "Execution handle belongs to a different session")
            if row["session_id"] is None:
                raise HostError("receipt_schema", "Original process handle identity is unavailable")
            result = dict(row)
            result["spec"] = decode_json(result["spec"])
            result["scope"] = decode_json(result["scope"])
            return result

    def validate_claim(self, marker: str, generation: str, spec: dict[str, Any]) -> dict[str, Any]:
        parts = marker.split(".")
        if len(parts) != 2 or len(parts[0]) != 32 or len(parts[1]) != 64:
            raise HostError("invalid_lease", "Malformed launch lease")
        with self.lock:
            row = self.operation(parts[0])
            digest = hashlib.sha256(parts[1].encode()).hexdigest()
            if not secrets.compare_digest(digest, row["token_hash"]):
                raise HostError("invalid_lease", "Invalid launch lease")
            if row["generation"] != generation or row["state"] != "allocated":
                raise HostError("invalid_lease", "Stale, revoked or consumed launch lease")
            self.environment(generation)
            self.assert_authority(row["principal"], row["owner"], generation, row["authority_revision"])
            # Docker adds image/default variables to exec. Every admitted
            # variable must arrive unchanged; extras never reach task code:
            # the adapter restores the exact leased environment before runc.
            observed_env = dict(value.split("=", 1) for value in spec["env"])
            expected_env = dict(value.split("=", 1) for value in row["spec"]["env"])
            observed = {**spec, "env": row["spec"]["env"]}
            if "argv0" in row["spec"]:
                observed["argv0"] = row["spec"]["argv0"]
            if "detachedLogPath" in row["spec"]:
                if "detachedLogPath" in spec:
                    raise HostError("invalid_lease", "OCI input cannot select its detached log")
                observed["detachedLogPath"] = row["spec"]["detachedLogPath"]
            if "files" in row["spec"]:
                if "files" in spec:
                    raise HostError("invalid_lease", "OCI input cannot supply held descriptor attestations")
                observed["files"] = row["spec"]["files"]
                if has_file(row["spec"], "cwd"):
                    if spec["cwd"] != "/":
                        raise HostError("invalid_lease", "Bound-directory launch did not use its private bootstrap cwd")
                    observed["cwd"] = row["spec"]["cwd"]
            if (any(observed_env.get(key) != value for key, value in expected_env.items()) or
                    encode_json(row["spec"]) != encode_json(observed)):
                raise HostError("invalid_lease", "Resolved process specification does not match launch lease")
            return row

    def transition(self, operation: str, expected: tuple[str, ...], state: str,
                   kind: str, **fields: Any) -> None:
        allowed = {"runtime_pid", "exec_id", "runtime_exit", "leader_exited",
                   "output_complete", "cleanup_proven", "failure", "exit_code", "residual_processes_terminated",
                   "leader_pid", "leader_start_time", "task_pid"}
        if not fields.keys() <= allowed:
            raise ValueError("Invalid receipt field")
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                row = self.operation(operation)
                if row["state"] not in expected:
                    raise HostError("invalid_transition", "Execution receipt cannot make this transition")
                assignments = ["state=?"] + [f"{key}=?" for key in fields]
                self.db.execute(f"UPDATE operations SET {','.join(assignments)} WHERE id=?",
                                [state, *fields.values(), operation])
                self._receipt(operation, kind, fields)
                self.db.execute("COMMIT")
            except BaseException:
                self.db.execute("ROLLBACK")
                raise

    def begin_input(self, operation: str, input_id: str, digest: str) -> bool:
        """False means a proven prior acknowledgement; never send bytes twice."""
        if not isinstance(input_id, str) or not 0 < len(input_id) <= 256:
            raise HostError("invalid_request", "Input requires a bounded stable call identity")
        with self.lock:
            previous = self.db.execute("SELECT * FROM inputs WHERE operation_id=? AND input_id=?",
                                       (operation, input_id)).fetchone()
            if previous is not None:
                if previous["digest"] != digest:
                    raise HostError("input_conflict", "Input call identity cannot be reused for different bytes")
                if previous["state"] == "acknowledged":
                    return False
                raise HostError("unknown_outcome", "Original input acknowledgement is unknown; bytes are not repeated")
            self.db.execute("BEGIN IMMEDIATE")
            try:
                self.db.execute("INSERT INTO inputs VALUES(?,?,?,'intent')", (operation, input_id, digest))
                self._receipt(operation, "input_intent", {"inputId": input_id, "digest": digest})
                self.db.execute("COMMIT")
            except BaseException:
                self.db.execute("ROLLBACK")
                raise
            return True

    def acknowledge_input(self, operation: str, input_id: str) -> None:
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                cursor = self.db.execute("UPDATE inputs SET state='acknowledged' WHERE operation_id=? "
                                         "AND input_id=? AND state='intent'", (operation, input_id))
                if cursor.rowcount != 1:
                    raise HostError("invalid_transition", "Input has no unsettled intent")
                self._receipt(operation, "input_acknowledged", {"inputId": input_id})
                self.db.execute("COMMIT")
            except BaseException:
                self.db.execute("ROLLBACK")
                raise

    def close(self) -> None:
        self.db.close()

    def begin_filesystem_effect(self, generation: str, principal: int, owner: str,
                                identity: dict[str, Any], arguments: dict[str, Any]) -> str:
        if not isinstance(identity, dict) or any(
                not bounded_identity(identity.get(key))
                for key in ("runId", "callId")) or type(identity.get("attempt")) is not int or identity["attempt"] < 1:
            raise HostError("invalid_request", "Filesystem mutations require the admitted run/call/attempt identity")
        digest = hashlib.sha256(encode_json(arguments)).hexdigest()
        index = operation_index(identity.get("operationIndex", 0))
        with self.lock:
            previous = self.db.execute("SELECT id FROM filesystem_effects WHERE generation=? AND principal=? "
                                       "AND owner=? AND run_id=? AND call_id=? AND attempt=? AND operation_index=?",
                                       (generation, principal, owner, identity["runId"], identity["callId"], identity["attempt"], index)).fetchone()
            if previous is not None:
                raise HostError("operation_exists", "Inspect the original filesystem mutation; it is not repeated")
            operation = secrets.token_hex(16)
            self.db.execute("BEGIN IMMEDIATE")
            try:
                self.db.execute("INSERT INTO filesystem_effects "
                                "(id,generation,principal,owner,run_id,call_id,attempt,digest,state,result,operation_index) "
                                "VALUES(?,?,?,?,?,?,?,?,'intent',NULL,?)",
                                (operation, generation, principal, owner, identity["runId"], identity["callId"], identity["attempt"], digest, index))
                self._receipt(operation, "filesystem_mutation_intent", {"digest": digest, "request": arguments})
                self.db.execute("COMMIT")
            except BaseException:
                self.db.execute("ROLLBACK")
                raise
            return operation

    def settle_filesystem_effect(self, operation: str, result: dict[str, Any]) -> None:
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                cursor = self.db.execute("UPDATE filesystem_effects SET state='acknowledged',result=? "
                                         "WHERE id=? AND state='intent'", (encode_json(result), operation))
                if cursor.rowcount != 1:
                    raise HostError("invalid_transition", "Filesystem mutation has no unsettled intent")
                self._receipt(operation, "filesystem_mutation_acknowledged", result)
                self.db.execute("COMMIT")
            except BaseException:
                self.db.execute("ROLLBACK")
                raise

    def filesystem_effect(self, generation: str, principal: int, owner: str,
                          identity: dict[str, Any]) -> dict[str, Any] | None:
        with self.lock:
            row = self.db.execute("SELECT id,state,result,digest FROM filesystem_effects WHERE generation=? AND principal=? "
                                  "AND owner=? AND run_id=? AND call_id=? AND attempt=? AND operation_index=?",
                                  (generation, principal, owner, identity["runId"], identity["callId"], identity["attempt"],
                                   operation_index(identity.get("operationIndex", 0)))).fetchone()
            if row is None:
                return None
            intent = self.db.execute("SELECT payload FROM receipts WHERE operation_id=? "
                                     "AND kind='filesystem_mutation_intent' ORDER BY sequence LIMIT 1", (row["id"],)).fetchone()
            retained = {} if intent is None else decode_json(intent["payload"])
            if "request" in retained and (retained.get("digest") != row["digest"] or
                    hashlib.sha256(encode_json(retained["request"])).hexdigest() != row["digest"]):
                raise HostError("receipt_corrupt", "Retained filesystem request does not match its committed digest")
            return {"id": row["id"], "state": row["state"],
                    "result": None if row["result"] is None else decode_json(row["result"]),
                    **({"request": retained["request"]} if "request" in retained else {})}

    def call_operations(self, generation: str, principal: int, owner: str, identity: dict[str, Any],
                        kind: str, after: int = -1, maximum: int = 128) -> list[dict[str, Any]]:
        """Enumerate original receipts, including unknown effects; never dispatch."""
        table = {"process": "operations", "filesystem": "filesystem_effects"}.get(kind)
        if table is None or type(after) is not int or after < -1 or type(maximum) is not int or not 1 <= maximum <= 128:
            raise HostError("invalid_request", "Invalid bounded operation enumeration")
        with self.lock:
            rows = self.db.execute(f"SELECT id,operation_index,state FROM {table} WHERE generation=? AND principal=? "
                                   "AND owner=? AND run_id=? AND call_id=? AND attempt=? AND operation_index>? "
                                   "ORDER BY operation_index LIMIT ?", (generation, principal, owner, identity["runId"],
                                                                        identity["callId"], identity["attempt"], after, maximum)).fetchall()
        return [{"operationId": row["id"], "operationIndex": row["operation_index"], "state": row["state"]} for row in rows]
