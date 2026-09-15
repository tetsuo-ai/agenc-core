"""Fixed pre-coordinate receipt schemas, including a migration failure window."""

import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "native/execution-host"))
from leases import LeaseStore
from protocol import HostError

LEGACY_SCHEMA = """
CREATE TABLE operations (
 id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, generation TEXT NOT NULL,
 principal INTEGER NOT NULL, owner TEXT NOT NULL, run_id TEXT NOT NULL,
 call_id TEXT NOT NULL, attempt INTEGER NOT NULL, authority_revision INTEGER NOT NULL,
 spec BLOB NOT NULL, state TEXT NOT NULL, scope BLOB NOT NULL, detached INTEGER NOT NULL,
 created_at INTEGER NOT NULL, runtime_pid INTEGER, exec_id TEXT, runtime_exit INTEGER,
 leader_exited INTEGER NOT NULL DEFAULT 0, output_complete INTEGER NOT NULL DEFAULT 0,
 cleanup_proven INTEGER NOT NULL DEFAULT 0, failure TEXT,
 UNIQUE(generation, principal, owner, run_id, call_id, attempt)
);
CREATE TABLE filesystem_effects (
 id TEXT PRIMARY KEY, generation TEXT NOT NULL, principal INTEGER NOT NULL,
 owner TEXT NOT NULL, run_id TEXT NOT NULL, call_id TEXT NOT NULL, attempt INTEGER NOT NULL,
 digest TEXT NOT NULL, state TEXT NOT NULL, result BLOB,
 UNIQUE(generation,principal,owner,run_id,call_id,attempt)
);
"""


class ReceiptMigrationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / "legacy.sqlite"
        with sqlite3.connect(self.path) as old:
            old.executescript(LEGACY_SCHEMA)
            old.execute("INSERT INTO operations "
                        "(id,token_hash,generation,principal,owner,run_id,call_id,attempt,authority_revision,"
                        "spec,state,scope,detached,created_at,failure) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        ("old-process", "hash", "generation", 1000, "owner", "run", "call", 1, 7,
                         b'{"args":["/bin/true"]}', "claimed", b"{}", 0, 123, "uncertain start"))
            old.execute("INSERT INTO filesystem_effects VALUES(?,?,?,?,?,?,?,?,?,?)",
                        ("old-mutation", "generation", 1000, "owner", "run", "call", 1, "digest", "intent", None))

    def tearDown(self):
        self.directory.cleanup()

    def test_old_operations_retain_index_zero_and_cannot_be_dispatched_twice(self):
        store = LeaseStore(self.path)
        try:
            row = store.operation("old-process", 1000, "owner")
            handle = row["session_id"]
            namespace = store.process_handle_namespace
            self.assertGreater(handle, 0)
            self.assertEqual((row["operation_index"], row["state"], row["failure"], row["spec"]),
                             (0, "claimed", "uncertain start", {"args": ["/bin/true"]}))
            identity = {"runId": "run", "callId": "call", "attempt": 1}
            self.assertEqual(store.filesystem_effect("generation", 1000, "owner", identity),
                             {"id": "old-mutation", "state": "intent", "result": None})
            with self.assertRaises(HostError) as duplicate:
                store.begin_filesystem_effect("generation", 1000, "owner", identity, {})
            self.assertEqual(duplicate.exception.code, "operation_exists")
            second = store.begin_filesystem_effect("generation", 1000, "owner", {**identity, "operationIndex": 1}, {})
            self.assertNotEqual(second, "old-mutation")
            self.assertEqual([value["operationIndex"] for value in store.call_operations(
                "generation", 1000, "owner", identity, "filesystem")], [0, 1])
        finally:
            store.close()
        reopened = LeaseStore(self.path)
        try:
            self.assertEqual(reopened.operation("old-process")["operation_index"], 0)
            self.assertEqual(reopened.operation("old-process")["session_id"], handle)
            self.assertEqual(reopened.process_handle_namespace, namespace)
            self.assertEqual(reopened.filesystem_effect("generation", 1000, "owner", identity)["state"], "intent")
        finally:
            reopened.close()

    def test_migration_failure_after_table_drop_rolls_back_original_receipts(self):
        class InterruptedMigration(sqlite3.Connection):
            def execute(self, statement, parameters=()):
                if statement.startswith("ALTER TABLE operations_coordinate_upgrade RENAME"):
                    raise OSError("injected migration interruption")
                return super().execute(statement, parameters)

        interrupted = sqlite3.connect(self.path, isolation_level=None, factory=InterruptedMigration)
        try:
            with patch("leases.sqlite3.connect", return_value=interrupted):
                with self.assertRaisesRegex(OSError, "migration interruption"):
                    LeaseStore(self.path)
            self.assertEqual(interrupted.execute("SELECT id FROM operations").fetchone()[0], "old-process")
            self.assertNotIn("operation_index", [row[1] for row in interrupted.execute("PRAGMA table_info(operations)")])
            self.assertIsNone(interrupted.execute("SELECT name FROM sqlite_master WHERE name='operations_coordinate_upgrade'").fetchone())
        finally:
            interrupted.close()
        recovered = LeaseStore(self.path)
        try:
            self.assertEqual(recovered.operation("old-process")["failure"], "uncertain start")
        finally:
            recovered.close()

    def test_handle_migration_rolls_back_as_one_transaction(self):
        class InterruptedMigration(sqlite3.Connection):
            def execute(self, statement, parameters=()):
                if statement.startswith("INSERT INTO process_handles(operation_id) SELECT"):
                    super().execute(statement, parameters)
                    raise OSError("interrupted after handle backfill")
                return super().execute(statement, parameters)

        interrupted = sqlite3.connect(self.path, isolation_level=None, factory=InterruptedMigration)
        try:
            with patch("leases.sqlite3.connect", return_value=interrupted):
                with self.assertRaisesRegex(OSError, "handle backfill"):
                    LeaseStore(self.path)
            self.assertIsNone(interrupted.execute("SELECT name FROM sqlite_master WHERE name='process_handles'").fetchone())
            self.assertIsNone(interrupted.execute("SELECT name FROM sqlite_master WHERE name='execution_host_metadata'").fetchone())
            self.assertEqual(interrupted.execute("SELECT failure FROM operations").fetchone()[0], "uncertain start")
        finally:
            interrupted.close()
        recovered = LeaseStore(self.path)
        try:
            self.assertGreater(recovered.operation("old-process")["session_id"], 0)
        finally:
            recovered.close()

    def test_missing_existing_handle_is_rejected_instead_of_reallocated(self):
        store = LeaseStore(self.path)
        store.db.execute("DELETE FROM process_handles")
        store.close()
        with self.assertRaises(HostError) as missing:
            LeaseStore(self.path)
        self.assertEqual(missing.exception.code, "receipt_schema")
        with sqlite3.connect(self.path) as raw:
            self.assertEqual(raw.execute("SELECT COUNT(*) FROM process_handles").fetchone()[0], 0)
