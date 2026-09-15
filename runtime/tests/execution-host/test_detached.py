"""Native detached startup uses a private descriptor and task-file stdout/stderr."""

import array
import fcntl
import os
import socket
import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, Mock

HOST = Path(__file__).resolve().parents[2] / "native/execution-host"
sys.path.insert(0, str(HOST))
from task_bootstrap import launch_descriptors
from detached import DetachedStartup, DetachedExecution
from leases import LeaseStore
from protocol import HostError


class DetachedNativeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.native = tempfile.TemporaryDirectory()
        cls.launcher = str(Path(cls.native.name) / "launcher")
        subprocess.run(["cc", "-std=c11", "-O2", "-static", "-Wall", "-Wextra", "-Werror",
                        str(HOST.parent / "agenc-task-launcher.c"), "-o", cls.launcher], check=True, capture_output=True)
        Path(cls.launcher).chmod(0o755)

    @classmethod
    def tearDownClass(cls):
        cls.native.cleanup()

    def start(self, args, path):
        reader, writer = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
        reader.settimeout(5)
        reader.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 1)
        source = fcntl.fcntl(writer.fileno(), fcntl.F_DUPFD_CLOEXEC, 10)
        try:
            with launch_descriptors({"args": args, "env": ["EXACT=α"], "detachedLogPath": str(path)}, self.launcher) as (program, payload):
                pid = os.posix_spawn(self.launcher, [self.launcher], {}, file_actions=[
                    (os.POSIX_SPAWN_DUP2, program, 3), (os.POSIX_SPAWN_DUP2, payload, 4), (os.POSIX_SPAWN_DUP2, source, 5)])
            return reader, pid
        except BaseException:
            reader.close()
            raise
        finally:
            os.close(source)
            writer.close()

    def receive(self, reader):
        payload, controls, flags, _ = reader.recvmsg(12, socket.CMSG_SPACE(4) + socket.CMSG_SPACE(12), socket.MSG_CMSG_CLOEXEC)
        self.assertEqual(flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC), 0)
        descriptors = []
        credentials = None
        for level, kind, data in controls:
            if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                values = array.array("i"); values.frombytes(data)
                descriptors.extend(values)
            elif level == socket.SOL_SOCKET and kind == socket.SCM_CREDENTIALS:
                credentials = struct.unpack("3i", data)
        return payload, descriptors, credentials

    def test_detached_target_has_file_output_closed_stdin_exact_environment_and_no_private_descriptors(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "service.log"
            script = ("import os,fcntl\nassert os.read(0,1)==b''\nassert os.environ=={'EXACT':'α','LC_CTYPE':'C.UTF-8'}\n"
                      "assert fcntl.fcntl(1,fcntl.F_GETFL)&os.O_APPEND\n"
                      "for fd in (3,4,5):\n try: fcntl.fcntl(fd,fcntl.F_GETFD)\n except OSError: pass\n else: raise AssertionError(fd)\n"
                      "os.write(1,b'\\x00\\xffstdout');os.write(2,b'stderr')\n")
            reader, pid = self.start([sys.executable, "-c", script], path)
            with reader:
                payload, descriptors, credentials = self.receive(reader)
                self.assertEqual(struct.unpack("!4sII", payload), (b"ADS1", 1, pid))
                self.assertEqual(credentials[0], pid)
                self.assertEqual(len(descriptors), 1)
                self.assertEqual(os.fstat(descriptors[0]).st_ino, path.stat().st_ino)
                os.close(descriptors[0])
                self.assertEqual(reader.recv(12), b"")
            _, status = os.waitpid(pid, 0)
            self.assertEqual(os.waitstatus_to_exitcode(status), 0, path.read_bytes())
            self.assertEqual(path.read_bytes(), b"\x00\xffstdoutstderr")

    def test_missing_program_reports_private_error_and_does_not_fabricate_readiness(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "failure.log"
            reader, pid = self.start([str(Path(directory) / "no-program")], path)
            with reader:
                payload, descriptors, _ = self.receive(reader)
                self.assertEqual(struct.unpack("!4sII", payload)[:2], (b"ADS1", 1))
                for fd in descriptors: os.close(fd)
                error, descriptors, _ = self.receive(reader)
                self.assertEqual(struct.unpack("!4sII", error), (b"ADS1", 2, 2))
                self.assertEqual(descriptors, [])
            _, status = os.waitpid(pid, 0)
            self.assertEqual(os.waitstatus_to_exitcode(status), 127)

    def test_existing_log_or_symlink_executes_no_target_instructions(self):
        with tempfile.TemporaryDirectory() as directory:
            original = Path(directory) / "original"
            original.write_text("keep")
            link = Path(directory) / "link"
            link.symlink_to(original)
            marker = Path(directory) / "must-not-execute"
            for path in (original, link):
                reader, pid = self.start(["/usr/bin/touch", str(marker)], path)
                with reader:
                    error, descriptors, _ = self.receive(reader)
                    self.assertEqual(struct.unpack("!4sII", error)[:2], (b"ADS1", 2))
                    self.assertEqual(descriptors, [])
                _, status = os.waitpid(pid, 0)
                self.assertEqual(os.waitstatus_to_exitcode(status), 125)
                self.assertFalse(marker.exists())
            self.assertEqual(original.read_text(), "keep")


class DetachedOutputTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.store = LeaseStore(self.root / "receipts.sqlite")
        self.operation = "a" * 32
        self.log = self.root / "task.log"
        self.log.write_bytes(b"original output")
        self.store.register_environment({"generation": "test", "containerId": "b" * 64})
        self.store.authorize(1000, "owner", "test", 0)
        self.store.allocate(generation="test", principal=1000, owner="owner", run_id="run", call_id="call", attempt=1,
                            authority_revision=0, spec={"detachedLogPath": str(self.log)}, scope={}, detached=True, operation_id=self.operation)
        metadata = self.log.stat()
        self.mirror = self.root / (self.operation + ".detached-output")
        self.mirror.touch(mode=0o600)
        self.store.db.execute("INSERT INTO detached_startups(operation_id,state,log_dev,log_ino,log_mode) VALUES(?,'bootstrap_closed',?,?,?)",
                              (self.operation, str(metadata.st_dev), str(metadata.st_ino), metadata.st_mode))
        self.startup = DetachedStartup(self.store, self.operation, None, self.unavailable, self.root)
        self.startup.log_fd = os.open(self.log, os.O_RDONLY | os.O_CLOEXEC)

    def unavailable(self):
        raise HostError("environment_dead", "Original task environment is unavailable")

    def tearDown(self):
        self.startup.close()
        self.store.close()
        self.directory.cleanup()

    def test_retained_output_survives_task_log_replacement_and_reopen(self):
        first = self.startup.output(0, 8)
        self.assertEqual(first["nextOffset"], 8)
        self.assertEqual(self.mirror.read_bytes(), b"original")
        self.log.write_bytes(b"forged replacement")
        self.assertEqual(self.startup.output(0, 8), first)
        self.startup.close()
        self.store.close()
        self.store = LeaseStore(self.root / "receipts.sqlite")
        self.startup = DetachedStartup(self.store, self.operation, None, self.unavailable, self.root)
        self.assertEqual(self.startup.output(0, 100), first)
        with self.assertRaises(HostError) as missing:
            self.startup.output(8, 100)
        self.assertEqual(missing.exception.code, "environment_dead")

    def test_lost_retention_receipt_preserves_unsettled_bytes_without_repeating_capture(self):
        with patch.object(self.store, "_receipt", side_effect=OSError("injected acknowledgement failure")):
            with self.assertRaisesRegex(OSError, "acknowledgement failure"):
                self.startup.output(0, 8)
        self.assertEqual(self.mirror.read_bytes(), b"original")
        self.assertEqual(self.startup.receipt()["mirrored_length"], 0)
        self.log.write_bytes(b"new bytes must not replace evidence")
        with self.assertRaises(HostError) as unsettled:
            self.startup.output(0, 8)
        self.assertEqual(unsettled.exception.code, "output_unavailable")
        self.assertEqual(self.mirror.read_bytes(), b"original")

    def test_terminal_capture_retains_the_final_tail_before_output_completion(self):
        self.startup.output(0, 2)
        self.startup.capture_final_output()
        self.assertEqual(self.mirror.read_bytes(), b"original output")
        self.assertEqual(self.startup.receipt()["mirrored_length"], len(b"original output"))
        self.assertEqual(self.startup.output(len(b"original output"), 10)["nextOffset"], len(b"original output"))

    def test_unclaimed_recovery_never_turns_docker_default_exit_zero_into_a_process_result(self):
        self.store.db.execute("UPDATE detached_startups SET state='waiting' WHERE operation_id=?", (self.operation,))
        self.startup.error = HostError("unknown_outcome", "Original startup never acknowledged")
        docker = Mock()
        execution = DetachedExecution(self.operation, self.store, docker, self.root, Mock(),
                                      startup=self.startup, finish_scope=Mock())
        execution._run_detached(self.store.operation(self.operation), False)
        docker.request.assert_not_called()
        row = self.store.operation(self.operation)
        self.assertIsNone(row["exit_code"])
        self.assertFalse(row["leader_exited"])
        self.assertIn("never acknowledged", row["failure"])
