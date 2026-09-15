"""Private descriptor transport and native pre-execution validation contracts."""
from __future__ import annotations

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

HOST = Path(__file__).resolve().parents[2] / "native/execution-host"
sys.path.insert(0, str(HOST))
from protocol import HostError, receive_descriptors, send
from task_bootstrap import launch_descriptors
from task_files import describe_file, validate_files


class DescriptorProtocolTests(unittest.TestCase):
    def test_private_handoff_preserves_held_inode_and_cloexec_across_a_path_swap(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "original"
            path.write_bytes(b"held\0\xff")
            with path.open("rb") as original:
                identity = os.fstat(original.fileno())
                path.rename(path.with_name("moved"))
                path.write_bytes(b"replacement")
                first, second = socket.socketpair()
                with first, second:
                    send(first, {"ok": True, "value": "α"}, (original.fileno(),))
                    response, descriptors = receive_descriptors(second)
                self.assertEqual(response["value"], "α")
                self.assertEqual(len(descriptors), 1)
                try:
                    received = descriptors[0]
                    self.assertEqual(os.fstat(received).st_ino, identity.st_ino)
                    self.assertTrue(fcntl.fcntl(received, fcntl.F_GETFD) & fcntl.FD_CLOEXEC)
                    self.assertEqual(os.read(received, 8), b"held\0\xff")
                finally:
                    os.close(descriptors[0])

    def test_bad_frames_close_all_received_descriptors(self):
        with tempfile.TemporaryFile() as source:
            for header, payload, copies in ((20, b"{}", 1), (2, b"{}", 1), (11, b'{"ok":true}', 3)):
                with self.subTest(copies=copies, payload=payload):
                    first, second = socket.socketpair()
                    with first, second:
                        before = set(os.listdir("/proc/self/fd"))
                        first.sendmsg([struct.pack("!I", header) + payload],
                                      [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", [source.fileno()] * copies))])
                        first.shutdown(socket.SHUT_WR)
                        with self.assertRaises(HostError):
                            receive_descriptors(second)
                        self.assertEqual(set(os.listdir("/proc/self/fd")), before)


class NativeDescriptorTests(unittest.TestCase):
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

    def execute(self, spec, descriptors):
        high = []
        try:
            for fd in descriptors:
                high.append(fcntl.fcntl(fd, fcntl.F_DUPFD_CLOEXEC, 20))
            with launch_descriptors(spec, self.launcher) as (program, payload), tempfile.TemporaryFile() as output:
                pid = os.posix_spawn(self.launcher, [self.launcher], {}, file_actions=[
                    (os.POSIX_SPAWN_DUP2, output.fileno(), 1), (os.POSIX_SPAWN_DUP2, output.fileno(), 2),
                    (os.POSIX_SPAWN_DUP2, program, 3), (os.POSIX_SPAWN_DUP2, payload, 4),
                    *[(os.POSIX_SPAWN_DUP2, fd, index + 5) for index, fd in enumerate(high)]])
                _, status = os.waitpid(pid, 0)
                output.seek(0)
                return os.waitstatus_to_exitcode(status), output.read()
        finally:
            for fd in high:
                os.close(fd)

    def test_bound_cwd_and_binary_stdin_survive_rename_and_close_private_descriptors(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "cwd").mkdir()
            (root / "input").write_bytes(b"\0\xffinput\r\n")
            cwd = os.open(root / "cwd", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
            source = os.open(root / "input", os.O_RDONLY | os.O_CLOEXEC)
            try:
                files = [describe_file(role, {"workerId": "a" * 32, "handle": index + 1}, fd)
                         for index, (role, fd) in enumerate((("cwd", cwd), ("stdin", source)))]
                (root / "cwd").rename(root / "moved")
                (root / "cwd").mkdir()
                code = ("import os,sys\nassert os.getcwd()==sys.argv[1]\n"
                        "for fd in (3,4,5,6):\n try: os.fstat(fd)\n except OSError: continue\n else: raise AssertionError('private fd survived')\n"
                        "sys.stdout.buffer.write(sys.stdin.buffer.read())")
                spec = {"args": ["/usr/bin/python3", "-c", code, str(root / "moved")], "env": ["LC_ALL=C.UTF-8"], "files": files}
                status, output = self.execute(spec, [cwd, source])
                self.assertEqual((status, output), (0, b"\0\xffinput\r\n"))
            finally:
                os.close(cwd); os.close(source)

    def test_replaced_or_changed_input_executes_no_target_instructions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "input").write_bytes(b"original")
            (root / "other").write_bytes(b"other")
            with (root / "input").open("rb") as source, (root / "other").open("rb") as other:
                proof = describe_file("stdin", {"workerId": "b" * 32, "handle": 1}, source.fileno())
                target = root / "must-not-execute"
                spec = {"args": ["/usr/bin/touch", str(target)], "env": [], "files": [proof]}
                self.assertEqual(self.execute(spec, [other.fileno()])[0], 125)
                self.assertFalse(target.exists())
                (root / "input").write_bytes(b"changed after admission")
                self.assertEqual(self.execute(spec, [source.fileno()])[0], 125)
                self.assertFalse(target.exists())

    def test_duplicate_roles_and_special_resource_proofs_fail_before_native_dispatch(self):
        with tempfile.TemporaryFile() as source:
            proof = describe_file("stdin", {"workerId": "c" * 32, "handle": 1}, source.fileno())
            with self.assertRaises(HostError):
                validate_files([proof, proof])
            with self.assertRaises(HostError):
                validate_files([{**proof, "identity": {**proof["identity"], "mode": 0o020666}}])
