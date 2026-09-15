"""Hermetic host protocol/state tests; kernel containment has a separate lane."""

from __future__ import annotations

import copy
import fcntl
import json
import os
import socket
import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

HOST = Path(__file__).resolve().parents[2] / "native/execution-host"
sys.path.insert(0, str(HOST))

from cgroups import cleanup_scopes
from containment import Containment
from environment import validate_profile
from filesystem import _reopen, _u32, FilesystemError
from leases import LeaseStore
from output import OutputIndex, read_output, record_output
from protocol import HostError, LEASE_ENV, MAX_FRAME_BYTES, bounded_identity, decode_json, peer_credentials, receive, send
from runtime_adapter import execution_spec, extract_lease, process_option, run, subcommand_index
from task_bootstrap import encode_bootstrap, launch_descriptors
from supervisor import Supervisor


class LeaseTests(unittest.TestCase):
    def test_call_has_distinct_operations_without_changing_its_canonical_identity(self):
        first, _ = self.allocate(index=0)
        second, _ = self.allocate(index=1, operation_id="c" * 32)
        identity = {"runId": "run", "callId": "call", "attempt": 1}
        self.assert_code("operation_exists", lambda: self.allocate(index=1, operation_id="d" * 32))
        page = self.store.call_operations("generation-a", 1000, "session-a", identity, "process", maximum=1)
        self.assertEqual(page, [{"operationId": first, "operationIndex": 0, "state": "allocated"}])
        self.assertEqual(self.store.call_operations("generation-a", 1000, "session-a", identity, "process", after=0),
                         [{"operationId": second, "operationIndex": 1, "state": "allocated"}])
        self.assertEqual(self.store.call_operations("generation-a", 1000, "session-b", identity, "process"), [])
        for index in (-1, True, 1.5):
            self.assert_code("invalid_request", lambda: self.allocate(index=index))

    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / "receipts.sqlite"
        self.store = LeaseStore(self.path)
        self.binding = {"generation": "generation-a", "containerId": "a" * 64,
                        "cgroupPath": "/unavailable/cgroup"}
        self.store.register_environment(self.binding)
        self.store.authorize(1000, "session-a", "generation-a", 7)
        self.spec = {"args": ["/bin/sh", "-c", "printf 'α\\n'"], "cwd": "/app",
                     "env": ["PATH=/usr/bin:/bin"], "terminal": False, "user": {"uid": 0, "gid": 0}}

    def tearDown(self) -> None:
        self.store.close()
        self.directory.cleanup()

    def allocate(self, **overrides):
        options = {"generation": "generation-a", "principal": 1000, "owner": "session-a",
                   "run_id": "run", "call_id": "call", "attempt": 1, "authority_revision": 7,
                   "spec": self.spec, "scope": {"command": "/missing", "commandIdentity": [1, 2],
                                                "launch": "/missing", "launchIdentity": [1, 3]},
                   "detached": False, "operation_id": "b" * 32}
        return self.store.allocate(**{**options, **overrides})

    def assert_code(self, code, function):
        with self.assertRaises(HostError) as result:
            function()
        self.assertEqual(result.exception.code, code)

    def test_numeric_handles_survive_restart_and_do_not_alias_other_owners_or_generations(self):
        first, marker = self.allocate()
        original = self.store.operation(first, 1000, "session-a")["session_id"]
        namespace = self.store.process_handle_namespace
        self.store.close()
        self.store = LeaseStore(self.path)
        self.assertEqual(self.store.process_handle_namespace, namespace)
        self.assertEqual(self.store.operation(first)["session_id"], original)
        self.assertEqual(self.store.validate_claim(marker, "generation-a", self.spec)["session_id"], original)
        self.store.authorize(1000, "session-b", "generation-a", 7)
        second, _ = self.allocate(owner="session-b", operation_id="c" * 32)
        self.assertGreater(self.store.operation(second)["session_id"], original)
        self.assert_code("owner_denied", lambda: self.store.operation(first, 1000, "session-b"))
        self.store.register_environment({**self.binding, "generation": "generation-b"})
        self.store.authorize(1000, "session-c", "generation-b", 7)
        third, _ = self.allocate(owner="session-c", generation="generation-b", operation_id="d" * 32)
        self.assertGreater(self.store.operation(third)["session_id"], self.store.operation(second)["session_id"])
        # Receipt retention may eventually retire rows, but SQLite's high water
        # mark must outlive them and a supervisor restart.
        self.store.db.execute("DELETE FROM operations")
        self.store.db.execute("DELETE FROM process_handles")
        self.store.close()
        self.store = LeaseStore(self.path)
        fourth, _ = self.allocate(operation_id="e" * 32)
        self.assertGreater(self.store.operation(fourth)["session_id"], original + 2)

    def test_handle_allocation_rolls_back_with_its_launch_lease_and_receipt(self):
        with patch.object(self.store, "_receipt", side_effect=OSError("injected receipt failure")):
            with self.assertRaisesRegex(OSError, "receipt failure"):
                self.allocate()
        for table in ("operations", "process_handles", "receipts"):
            self.assertEqual(self.store.db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0], 0)
        operation, _ = self.allocate()
        self.assertGreater(self.store.operation(operation)["session_id"], 0)

    def test_handle_exhaustion_cannot_commit_an_unaddressable_launch(self):
        self.allocate()
        self.store.db.execute("UPDATE sqlite_sequence SET seq=9007199254740990 WHERE name='process_handles'")
        last, _ = self.allocate(index=1, operation_id="c" * 32)
        self.assertEqual(self.store.operation(last)["session_id"], 9007199254740991)
        self.assert_code("process_limit", lambda: self.allocate(index=2, operation_id="d" * 32))
        self.assertEqual(self.store.db.execute("SELECT COUNT(*) FROM operations").fetchone()[0], 2)
        self.assertEqual(self.store.db.execute("SELECT COUNT(*) FROM receipts").fetchone()[0], 2)

    def test_replacement_store_has_a_different_handle_namespace(self):
        other = LeaseStore(Path(self.directory.name) / "replacement.sqlite")
        try:
            self.assertNotEqual(other.process_handle_namespace, self.store.process_handle_namespace)
        finally:
            other.close()

    def test_original_store_fence_rejects_control_requests_before_dispatch(self):
        supervisor = object.__new__(Supervisor)
        supervisor.store = self.store
        for method in ("bind", "authorize", "launch", "input", "filesystem", "stop", "close"):
            self.assert_code("receipt_store_changed", lambda: supervisor._controller(
                {"method": method, "processHandleNamespace": "missing-original-store"}, 1000))

    def test_residual_receipt_requires_leader_exit_observation_and_successful_command_cleanup(self):
        class ScopeFixture:
            def __init__(self, populated=False, failure=False):
                self.was_populated = populated
                self.failure = failure
            def populated(self):
                return self.was_populated
            def kill_and_wait(self, deadline):
                if self.failure:
                    raise HostError("cleanup_unproven", "fixture scope still populated")
            def close(self):
                pass

        for index, (leader, detached, populated, failure, expected) in enumerate([
                (True, False, True, False, 1), (False, False, True, False, 0),
                (True, True, True, False, 0), (True, False, False, False, 0),
                (True, False, True, True, 0)]):
            with self.subTest(index=index):
                operation, _ = self.allocate(index=index, operation_id=f"{index:032x}", detached=detached)
                self.store.transition(operation, ("allocated",), "running", "fixture_started", leader_exited=int(leader))
                containment = Containment(self.store, Path("/missing"), lambda _: self.binding)
                with patch.object(containment, "_scopes", return_value=(ScopeFixture(populated, failure), ScopeFixture())):
                    if failure:
                        self.assert_code("cleanup_unproven", lambda: containment.stop(operation, 1000, "session-a"))
                    else:
                        containment.stop(operation, 1000, "session-a")
                row = self.store.operation(operation)
                self.assertEqual(row["residual_processes_terminated"], expected)
                self.assertEqual(row["cleanup_proven"], int(not failure))
                self.store.close()
                self.store = LeaseStore(self.path)
                self.assertEqual(self.store.operation(operation)["residual_processes_terminated"], expected)

    def test_claim_is_bound_to_exact_spec_generation_and_one_use(self):
        operation, marker = self.allocate()
        self.assertEqual(self.store.validate_claim(marker, "generation-a", self.spec)["id"], operation)
        self.assert_code("invalid_lease", lambda: self.store.validate_claim(marker, "other", self.spec))
        for key, value in (("cwd", "/elsewhere"), ("args", ["/bin/true"]),
                           ("env", ["PROVIDER_SECRET=unexpected"]), ("terminal", True)):
            self.assert_code("invalid_lease", lambda: self.store.validate_claim(
                marker, "generation-a", {**self.spec, key: value}))
        self.store.transition(operation, ("allocated",), "claimed", "lease_claimed", runtime_pid=42)
        self.assert_code("invalid_lease", lambda: self.store.validate_claim(marker, "generation-a", self.spec))

    def test_revocation_wins_before_delayed_claim(self):
        operation, marker = self.allocate()
        self.store.transition(operation, ("allocated",), "stopping", "cancellation_fenced")
        # Even an initially empty cgroup cannot make the lease usable again.
        self.assert_code("invalid_lease", lambda: self.store.validate_claim(marker, "generation-a", self.spec))
        self.store.transition(operation, ("stopping",), "stopped", "cleanup_proven", cleanup_proven=1)
        self.assert_code("invalid_lease", lambda: self.store.validate_claim(marker, "generation-a", self.spec))

    def test_image_defaults_can_be_removed_but_admitted_variables_cannot_change(self):
        _, marker = self.allocate()
        delivered = {**self.spec, "env": ["HOSTNAME=task", *self.spec["env"], "IMAGE_DEFAULT=present"]}
        row = self.store.validate_claim(marker, "generation-a", delivered)
        self.assertEqual(row["spec"]["env"], ["PATH=/usr/bin:/bin"])
        self.assert_code("invalid_lease", lambda: self.store.validate_claim(marker, "generation-a",
                         {**delivered, "env": ["PATH=/attacker"]}))

    def test_closed_authority_cannot_be_reopened_by_an_old_revision(self):
        self.store.db.execute("UPDATE authorities SET closed=1")
        self.assert_code("invalid_authority", self.allocate)
        self.assert_code("invalid_authority", lambda: self.store.authorize(1000, "session-a", "generation-a", 7))
        self.store.authorize(1000, "session-a", "generation-a", 8)
        self.allocate(authority_revision=8)

    def test_restart_preserves_operation_and_refuses_duplicate_dispatch_identity(self):
        operation, marker = self.allocate()
        self.store.transition(operation, ("allocated",), "claimed", "lease_claimed", runtime_pid=42)
        self.store.close()
        self.store = LeaseStore(self.path)
        row = self.store.operation(operation, 1000, "session-a")
        self.assertEqual(row["state"], "claimed")
        self.assertEqual(row["spec"], self.spec)
        self.assert_code("invalid_lease", lambda: self.store.validate_claim(marker, "generation-a", self.spec))
        self.assert_code("operation_exists", lambda: self.allocate(operation_id="c" * 32))
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM operations").fetchone()[0], 1)

    def test_foreign_owner_or_principal_cannot_inspect(self):
        operation, _ = self.allocate()
        self.assert_code("owner_denied", lambda: self.store.operation(operation, 1000, "session-b"))
        self.assert_code("owner_denied", lambda: self.store.operation(operation, 1001, "session-a"))

    def test_binding_cannot_be_replaced_or_quarantine_cleared_by_rebind(self):
        self.store.register_environment(self.binding)
        self.assert_code("environment_unavailable", lambda: self.store.register_environment(
            {**self.binding, "containerId": "c" * 64}))
        self.store.quarantine("generation-a", "unproven cleanup")
        self.assert_code("environment_unavailable", lambda: self.store.register_environment(self.binding))
        self.assert_code("environment_unavailable", self.allocate)

    def test_authority_cannot_be_replaced_rolled_back_or_changed_with_live_work(self):
        operation, marker = self.allocate()
        self.assert_code("invalid_authority", lambda: self.allocate(authority_revision=6))
        self.assert_code("invalid_authority", lambda: self.store.authorize(1000, "session-a", "generation-a", 6))
        self.assert_code("cleanup_unproven", lambda: self.store.authorize(1000, "session-a", "generation-a", 8))
        self.store.transition(operation, ("allocated",), "stopped", "cleanup_proven", cleanup_proven=1)
        self.store.authorize(1000, "session-a", "generation-a", 8)
        self.assert_code("invalid_authority", self.allocate)
        self.assert_code("invalid_lease", lambda: self.store.validate_claim(marker, "generation-a", self.spec))

    def test_missing_scope_is_explicit_failure_and_quarantines_environment(self):
        operation, _ = self.allocate()
        containment = Containment(self.store, Path("/missing"), lambda _: self.binding)
        self.assert_code("cleanup_unproven", lambda: containment.stop(operation, 1000, "session-a"))
        row = self.store.operation(operation, 1000, "session-a")
        self.assertEqual(row["state"], "quarantined")
        self.assertFalse(row["cleanup_proven"])
        self.assert_code("environment_unavailable", lambda: self.store.environment("generation-a"))
        self.assert_code("cleanup_unproven", lambda: containment.stop(operation, 1000, "session-a"))

    def test_native_bootstrap_limits_are_rejected_before_scope_allocation(self):
        containment = Containment(self.store, Path("/missing"), lambda _: self.binding)
        options = {"generation": "generation-a", "principal": 1000, "owner": "session-a",
                   "run_id": "run", "call_id": "call", "attempt": 1, "authority_revision": 7}
        with patch("containment.Scope.create") as create:
            self.assert_code("invalid_process", lambda: containment.allocate(
                **options, spec={**self.spec, "args": ["/bin/true", *([""] * 65536)]}))
            self.assert_code("invalid_process", lambda: containment.allocate(
                **options, spec={**self.spec, "env": [LEASE_ENV + "=forged"]}))
            self.assert_code("invalid_request", lambda: containment.allocate(**options, spec=self.spec, detached="true"))
            create.assert_not_called()

    def test_recovery_inspects_and_cleans_but_never_dispatches(self):
        operation, _ = self.allocate()
        containment = Containment(self.store, Path("/missing"), lambda _: self.binding)
        containment.recover()
        self.assertEqual(self.store.operation(operation)["state"], "quarantined")
        receipts = self.store.db.execute("SELECT kind FROM receipts ORDER BY sequence").fetchall()
        self.assertEqual([row[0] for row in receipts],
                         ["allocated", "cancellation_fenced", "cleanup_unproven"])

    def test_input_acknowledgements_never_repeat_sent_or_uncertain_bytes(self):
        operation, _ = self.allocate()
        self.assertTrue(self.store.begin_input(operation, "input-1", "first-digest"))
        self.assert_code("unknown_outcome", lambda: self.store.begin_input(operation, "input-1", "first-digest"))
        self.store.acknowledge_input(operation, "input-1")
        self.assertFalse(self.store.begin_input(operation, "input-1", "first-digest"))
        self.assert_code("input_conflict", lambda: self.store.begin_input(operation, "input-1", "different-digest"))
        self.assertTrue(self.store.begin_input(operation, "input-2", "second-digest"))
        self.store.close()
        self.store = LeaseStore(self.path)
        self.assertFalse(self.store.begin_input(operation, "input-1", "first-digest"))
        self.assert_code("unknown_outcome", lambda: self.store.begin_input(operation, "input-2", "second-digest"))

    def test_filesystem_effect_recovery_retains_intent_and_original_acknowledgement(self):
        identity = {"runId": "run", "callId": "file-write", "attempt": 1}
        effect = self.store.begin_filesystem_effect("generation-a", 1000, "session-a", identity,
                                                    {"operation": "write", "handle": 1})
        self.assert_code("operation_exists", lambda: self.store.begin_filesystem_effect(
            "generation-a", 1000, "session-a", identity, {"operation": "write", "handle": 1}))
        self.store.close()
        self.store = LeaseStore(self.path)
        pending = self.store.filesystem_effect("generation-a", 1000, "session-a", identity)
        self.assertEqual(pending, {"id": effect, "state": "intent", "result": None,
                                   "request": {"operation": "write", "handle": 1}})
        self.assertIsNone(self.store.filesystem_effect("generation-a", 1000, "session-b", identity))
        self.store.settle_filesystem_effect(effect, {"ok": True})
        self.assertEqual(self.store.filesystem_effect("generation-a", 1000, "session-a", identity)["result"], {"ok": True})
        self.assert_code("operation_exists", lambda: self.store.begin_filesystem_effect(
            "generation-a", 1000, "session-a", identity, {"operation": "write", "handle": 2}))

    def test_directory_failure_retains_original_quarantine_request_after_reopen(self):
        identity = {"runId": "run", "callId": "directory-remove", "attempt": 1, "operationIndex": 4}
        arguments = {"workerId": "worker", "operation": "remove_directory",
                     "arguments": {"handle": 3, "path": "/app/tree", "quarantine": ".agenc-delete-original"}}
        effect = self.store.begin_filesystem_effect("generation-a", 1000, "session-a", identity, arguments)
        arguments["arguments"]["quarantine"] = ".agenc-delete-replacement"
        self.store.settle_filesystem_effect(effect, {"ok": False, "code": "unsupported_resource", "mutationStarted": True})
        self.store.close()
        self.store = LeaseStore(self.path)
        recovered = self.store.filesystem_effect("generation-a", 1000, "session-a", identity)
        self.assertEqual(recovered["state"], "acknowledged")
        self.assertEqual(recovered["request"]["arguments"]["quarantine"], ".agenc-delete-original")
        self.assertEqual(recovered["result"], {"ok": False, "code": "unsupported_resource", "mutationStarted": True})
        self.assertIsNone(self.store.filesystem_effect("generation-a", 1000, "foreign", identity))
        self.store.db.execute("UPDATE receipts SET payload=? WHERE operation_id=? AND kind='filesystem_mutation_intent'",
                              (b'{"digest":"wrong","request":{}}', effect))
        self.assert_code("receipt_corrupt", lambda: self.store.filesystem_effect("generation-a", 1000, "session-a", identity))


class FilesystemProtocolTests(unittest.TestCase):
    def test_descriptor_reopen_retains_inode_after_path_exchange(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "file"
            path.write_bytes(b"held inode")
            fd = os.open(path, os.O_PATH | os.O_CLOEXEC)
            try:
                path.rename(Path(directory) / "moved")
                path.write_bytes(b"replacement")
                reopened = _reopen(fd, os.O_RDONLY)
                try:
                    self.assertEqual(os.read(reopened, 100), b"held inode")
                    self.assertEqual(os.fstat(fd).st_ino, os.fstat(reopened).st_ino)
                finally:
                    os.close(reopened)
                self.assertEqual(path.read_bytes(), b"replacement")
            finally:
                os.close(fd)

    def test_special_resource_is_rejected_before_io_open(self):
        with tempfile.TemporaryDirectory() as directory:
            fifo = Path(directory) / "fifo"
            os.mkfifo(fifo)
            for path in (fifo, "/dev/null", "/proc/self/status", "/sys/kernel"):
                with self.subTest(path=path):
                    fd = os.open(path, os.O_PATH | os.O_CLOEXEC)
                    try:
                        with patch("filesystem.os.open") as io_open:
                            with self.assertRaises(OSError) as failure:
                                _reopen(fd, os.O_RDONLY)
                            self.assertEqual(failure.exception.errno, 95)
                            io_open.assert_not_called()
                    finally:
                        os.close(fd)

    def test_descriptor_protocol_rejects_invalid_numeric_authority(self):
        for value in (True, -1, 0x100000000, "3", None):
            with self.subTest(value=value), self.assertRaises(HostError):
                _u32(value)


class OutputTests(unittest.TestCase):
    def test_fragmented_binary_streams_reconnect_at_any_payload_cursor_without_consumption(self):
        content = b"\1\0\0\0\0\0\0\5a\0\xffbc\2\0\0\0\0\0\0\3err\1\0\0\0\0\0\0\1z"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = LeaseStore(root / "receipts.sqlite")
            (root / "operation.output").write_bytes(content)
            index = OutputIndex(False)
            for byte in content:
                record_output(store, "operation", index.feed(bytes([byte])))
            index.finish()
            first = read_output(store, root, "operation", 0, 2)
            self.assertEqual(first, read_output(store, root, "operation", 0, 2))
            store.close()
            store = LeaseStore(root / "receipts.sqlite")
            import base64
            stdout, stderr, cursor = bytearray(), bytearray(), 0
            while True:
                result = read_output(store, root, "operation", cursor, 2)
                if cursor == result["nextOffset"]:
                    break
                stdout.extend(base64.b64decode(result["stdout"]))
                stderr.extend(base64.b64decode(result["stderr"]))
                cursor = result["nextOffset"]
            self.assertEqual(stdout, b"a\0\xffbcz")
            self.assertEqual(stderr, b"err")
            self.assertEqual(cursor, len(content))
            store.close()

    def test_terminal_stream_has_no_docker_header_and_incomplete_pipe_frames_do_not_settle(self):
        index = OutputIndex(True)
        self.assertEqual(index.feed(b"\x1b[0m\xff"), [(0, 5, 1)])
        index.finish()
        for content in (b"\1", b"\1\0\0\0\0\0\0\3ab"):
            index = OutputIndex(False)
            index.feed(content)
            with self.assertRaises(HostError):
                index.finish()
        with self.assertRaises(HostError):
            OutputIndex(False).feed(b"\3\0\0\0\0\0\0\1x")


class CleanupOrderingTests(unittest.TestCase):
    def test_runtime_fence_closes_before_command_cleanup(self):
        events = []
        class FakeScope:
            def __init__(self, name):
                self.name = name
            def kill_and_wait(self, deadline):
                events.append(self.name)
                if self.name == "launch":
                    events.append("late runc command moved before launch emptied")
            def populated(self):
                events.append("observe " + self.name)
                return True
        self.assertTrue(cleanup_scopes(FakeScope("launch"), FakeScope("command")))
        self.assertEqual(events, ["launch", "late runc command moved before launch emptied", "observe command", "command"])

    def test_failed_launch_fence_cannot_report_command_cleanup_success(self):
        class FailedLaunch:
            def kill_and_wait(self, deadline):
                raise HostError("cleanup_unproven", "runtime still live")
        class Command:
            def kill_and_wait(self, deadline):
                self.fail("Command cleanup attempted before launch fence closed")
        with self.assertRaisesRegex(HostError, "runtime still live"):
            cleanup_scopes(FailedLaunch(), Command())


class ProtocolTests(unittest.TestCase):
    def test_canonical_identity_bound_counts_utf8_bytes_and_rejects_invalid_unicode(self):
        self.assertTrue(bounded_identity("α" * 2048))
        self.assertFalse(bounded_identity("α" * 2049))
        self.assertFalse(bounded_identity("\ud800"))
        self.assertFalse(bounded_identity(" "))
    def test_private_channel_preserves_unicode_and_kernel_peer_identity(self):
        first, second = socket.socketpair()
        with first, second:
            send(first, {"value": " α\n\u0000 ", "args": ["", "-c", "$(literal)"]})
            self.assertEqual(receive(second), {"value": " α\n\u0000 ", "args": ["", "-c", "$(literal)"]})
            self.assertEqual(peer_credentials(second)[0:2], (os.getpid(), os.getuid()))

    def test_duplicate_json_fields_and_nonfinite_numbers_are_rejected(self):
        for data in (b'{"owner":"a","owner":"b"}', b'{"value":NaN}', b'[]', b'null'):
            with self.subTest(data=data):
                first, second = socket.socketpair()
                with first, second:
                    first.sendall(struct.pack("!I", len(data)) + data)
                    with self.assertRaises(HostError):
                        receive(second)

    def test_oversize_and_truncated_frames_fail_without_dispatch(self):
        for data in (struct.pack("!I", MAX_FRAME_BYTES + 1), struct.pack("!I", 10) + b"{}"):
            first, second = socket.socketpair()
            with first, second:
                first.sendall(data)
                first.shutdown(socket.SHUT_WR)
                with self.assertRaises(HostError):
                    receive(second)


class RuntimeAdapterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.native_directory = tempfile.TemporaryDirectory()
        cls.launcher = str(Path(cls.native_directory.name) / "launcher")
        subprocess.run(["cc", "-std=c11", "-O2", "-static", "-Wall", "-Wextra", "-Werror",
                        str(HOST.parent / "agenc-task-launcher.c"), "-o", cls.launcher], check=True, capture_output=True)
        Path(cls.launcher).chmod(0o755)

    @classmethod
    def tearDownClass(cls):
        cls.native_directory.cleanup()

    def test_native_task_bootstrap_preserves_exact_argv_environment_and_binary_stdin(self):
        target = {"args": ["/usr/bin/python3", "-c",
                           "import os,sys; assert dict(os.environ)=={'LC_ALL':'C.UTF-8','EXACT':' α😃 '}; "
                           "assert open('/proc/self/cmdline','rb').read().split(b'\\0')[0]==b'custom-name'; "
                           "assert sys.argv[1:]==['','α😃\\n']; "
                           "sys.stdout.buffer.write(sys.stdin.buffer.read())", "", "α😃\n"],
                  "argv0": "custom-name", "env": ["LC_ALL=C.UTF-8", "EXACT= α😃 "]}
        with launch_descriptors(target, self.launcher) as (program, payload), \
                tempfile.TemporaryFile() as source, tempfile.TemporaryFile() as output:
            source.write(b"\0\xffstdin\r\n"); source.seek(0)
            pid = os.posix_spawn(self.launcher, [self.launcher], {"CONTROLLER_SECRET": "must-not-inherit", "HOME": "/wrong"},
                                 file_actions=[(os.POSIX_SPAWN_DUP2, source.fileno(), 0),
                                               (os.POSIX_SPAWN_DUP2, output.fileno(), 1),
                                               (os.POSIX_SPAWN_DUP2, program, 3),
                                               (os.POSIX_SPAWN_DUP2, payload, 4)])
            _, status = os.waitpid(pid, 0)
            self.assertEqual(os.waitstatus_to_exitcode(status), 0)
            output.seek(0)
            self.assertEqual(output.read(), b"\0\xffstdin\r\n")

    def test_task_executable_descriptor_cannot_mutate_the_installed_host_binary(self):
        original = Path(self.launcher).stat()
        with launch_descriptors({"args": ["/bin/true"], "env": []}, self.launcher) as (program, payload):
            copied = os.fstat(program)
            self.assertNotEqual((original.st_dev, original.st_ino), (copied.st_dev, copied.st_ino))
            for fd in (program, payload):
                with self.assertRaises(PermissionError):
                    os.pwrite(fd, b"x", 0)
            os.fchmod(program, 0o777)
            self.assertEqual(Path(self.launcher).stat().st_mode, original.st_mode)

    def test_unsealed_or_malformed_bootstrap_executes_no_target_instructions(self):
        target_path = Path(self.native_directory.name) / "must-not-execute"
        encoded = encode_bootstrap({"args": ["/usr/bin/touch", str(target_path)], "env": []})
        for seal, content in ((False, encoded), (True, encoded[:-1]), (True, b"BAD!" + encoded[4:])):
            with self.subTest(seal=seal, size=len(content)):
                payload = os.memfd_create("test-bootstrap", os.MFD_CLOEXEC | os.MFD_ALLOW_SEALING)
                try:
                    os.write(payload, content)
                    if seal:
                        fcntl.fcntl(payload, fcntl.F_ADD_SEALS,
                                    fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL)
                    with tempfile.TemporaryFile() as errors:
                        pid = os.posix_spawn(self.launcher, [self.launcher], {},
                                             file_actions=[(os.POSIX_SPAWN_DUP2, errors.fileno(), 2),
                                                           (os.POSIX_SPAWN_DUP2, payload, 4)])
                        _, status = os.waitpid(pid, 0)
                        self.assertEqual(os.waitstatus_to_exitcode(status), 125)
                        self.assertFalse(target_path.exists())
                finally:
                    os.close(payload)

    def test_containerd_options_and_transport_marker_preserve_oci_security(self):
        argv = ["--root", "/run/runc", "--log=/run/log", "--systemd-cgroup", "exec",
                "--detach", "--pid-file", "/run/pid", "--process", "/run/process.json", "a" * 64]
        index = subcommand_index(argv)
        self.assertEqual(index, 4)
        self.assertEqual(process_option(argv, index), (8, "/run/process.json", "a" * 64))
        original = {"args": ["/bin/sh", "-c", "echo α"], "cwd": "/app",
                    "env": ["PATH=/usr/bin:/bin", LEASE_ENV + "=token", "A=literal=equals"],
                    "user": {"uid": 0, "gid": 0}, "terminal": True,
                    "apparmorProfile": "docker-default", "noNewPrivileges": True,
                    "capabilities": {"bounding": ["CAP_CHOWN"]},
                    "rlimits": [{"type": "RLIMIT_NOFILE", "hard": 1024, "soft": 1024}]}
        before = copy.deepcopy(original)
        marker, clean = extract_lease(original)
        self.assertEqual(marker, "token")
        self.assertEqual(original, before)
        self.assertEqual(clean, {**original, "env": ["PATH=/usr/bin:/bin", "A=literal=equals"]})

    def test_duplicate_empty_and_malformed_markers_fail_closed(self):
        for values in ([LEASE_ENV], [LEASE_ENV + "="], [LEASE_ENV + "=a", LEASE_ENV + "=b"]):
            with self.subTest(values=values), self.assertRaises(HostError):
                extract_lease({"env": values})

    def test_reserved_marker_without_oci_process_file_cannot_bypass(self):
        with self.assertRaises(HostError):
            process_option(["exec", "-e", LEASE_ENV + "=token", "container", "/bin/true"], 0)

    def test_ordinary_oci_and_healthcheck_operations_delegate_exactly(self):
        class ExecIntercept(BaseException):
            pass
        with tempfile.TemporaryDirectory() as directory:
            process = Path(directory) / "process.json"
            process.write_text('{"args":["/bin/true"],"env":["PATH=/usr/bin:/bin"]}')
            for argv in (["--version"], ["features"], ["--root", "/run/runc", "create", "container"],
                         ["exec", "--process", str(process), "container"]):
                with self.subTest(argv=argv), patch("runtime_adapter.os.execv", side_effect=ExecIntercept) as execute:
                    with self.assertRaises(ExecIntercept):
                        run(argv, runc_path="/qualified/runc")
                    execute.assert_called_once_with("/qualified/runc", ["/qualified/runc", *argv])

    def test_managed_adapter_uses_private_process_fd_and_exact_spec(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "process.json"
            observed = root / "observed.json"
            original = {"args": ["/bin/sh", "-c", "$(literal) α\n"], "cwd": "/app",
                        "env": ["PATH=/bin", "IMAGE_DEFAULT=must-not-inherit", LEASE_ENV + "=lease"], "terminal": False,
                        "user": {"uid": 0, "gid": 0}, "noNewPrivileges": True}
            source.write_text(json.dumps(original))
            # The test executable observes what the real adapter gives runc;
            # it does not simulate kernel isolation or execute task instructions.
            runc = root / "runc"
            runc.write_text("#!/usr/bin/python3 -I\nimport json,sys\n"
                            "p=sys.argv[sys.argv.index('--process')+1]\n"
                            f"json.dump({{'argv':sys.argv[1:],'process':json.load(open(p))}},open({str(observed)!r},'w'))\n")
            runc.chmod(0o755)
            messages = []
            def rpc(path, message):
                messages.append(message)
                if message["method"] == "claim":
                    return {"operationId": "operation", "subgroup": "agenc-scope", "pidfdSocket": "/run/private.pidfd",
                            "processSpec": execution_spec({**original, "env": ["PATH=/bin"]})}
                return {}
            with patch("runtime_adapter.request", side_effect=rpc), \
                    patch("runtime_adapter.request_descriptors", side_effect=lambda path, message: (rpc(path, message), ())):
                self.assertEqual(run(["exec", "--detach", "--process", str(source), "a" * 64],
                                     runc_path=str(runc), launcher_path=self.launcher), 0)
            result = json.loads(observed.read_text())
            self.assertEqual(result["process"], {**original, "args": ["/proc/self/fd/3"], "env": []})
            self.assertEqual(result["argv"][1:5], ["--cgroup", "agenc-scope", "--pidfd-socket", "/run/private.pidfd"])
            self.assertIn("/proc/self/fd/", result["argv"][result["argv"].index("--process") + 1])
            self.assertEqual([message["method"] for message in messages], ["claim", "runtime_finished"])
            self.assertEqual(messages[0]["spec"], execution_spec({**original, "env": ["PATH=/bin", "IMAGE_DEFAULT=must-not-inherit"]}))
            self.assertEqual(json.loads(source.read_text()), original)


class ProfileTests(unittest.TestCase):
    def setUp(self):
        self.info = {"OSType": "linux", "CgroupVersion": "2", "SecurityOptions": ["name=apparmor"]}
        self.container = {"Id": "a" * 64, "State": {"Running": True}, "Config": {"User": "0:0"},
                          "HostConfig": {"Runtime": "agenc-runc", "CgroupnsMode": "private",
                                         "IpcMode": "private", "NetworkMode": "bridge"},
                          "AppArmorProfile": "docker-default", "Mounts": []}

    def test_supported_profile_and_disabled_apparmor(self):
        validate_profile(self.info, self.container, (Path("/controller"),))
        self.container["AppArmorProfile"] = "unconfined"
        self.container["HostConfig"]["SecurityOpt"] = ["apparmor=unconfined"]
        validate_profile(self.info, self.container, (Path("/controller"),))

    def test_unsafe_profiles_are_rejected_before_execution(self):
        for key, value in (("Privileged", True), ("PidMode", "host"), ("IpcMode", "host"),
                           ("CgroupnsMode", "host"), ("NetworkMode", "host"),
                           ("NetworkMode", "container:other"), ("Runtime", "runc"),
                           ("CapAdd", ["SYS_ADMIN"]), ("SecurityOpt", ["seccomp=unconfined"])):
            with self.subTest(key=key, value=value):
                container = copy.deepcopy(self.container)
                container["HostConfig"][key] = value
                with self.assertRaises(HostError):
                    validate_profile(self.info, container, (Path("/controller"),))

    def test_controller_and_container_control_mounts_rejected(self):
        for source in ("/", "/controller", "/controller/logs", "/var/run/docker.sock", "/proc", "/sys/fs/cgroup"):
            with self.subTest(source=source):
                self.container["Mounts"] = [{"Source": source, "Type": "bind", "Propagation": "rprivate"}]
                with self.assertRaises(HostError):
                    validate_profile(self.info, self.container, (Path("/controller"),))


if __name__ == "__main__":
    unittest.main()
