"""Real-kernel controls for the private native init. No production routing.

Run in the sandbox kernel gate container, never skip missing prerequisites.
The direct-route broker integration and durable cancellation tests are separate.
"""
from pathlib import Path
import fcntl
import json
import os
import select
import signal
import struct
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
TEMP = tempfile.TemporaryDirectory(prefix="agenc-namespace-init-")
DIRECTORY = Path(TEMP.name)
HELPER = DIRECTORY / "init"
subprocess.run([
    "cc", "-Os", "-static", "-std=c11", "-Wall", "-Wextra", "-Werror",
    "-D_FORTIFY_SOURCE=2", "-fstack-protector-strong", "-Wl,-z,relro,-z,now",
    "-o", str(HELPER), str(ROOT / "native/agenc-namespace-init.c"),
], check=True)
RECORDS = []


def invoke(args, *, unsealed=False, leaked=False, report_file=False,
           helper=HELPER, timeout=10):
    output_read, output_write = os.pipe()
    report_read, report_write = os.pipe()
    snapshot = os.memfd_create("agenc-init-test", os.MFD_ALLOW_SEALING | os.MFD_CLOEXEC)
    data = helper.read_bytes()
    with os.fdopen(os.dup(snapshot), "wb") as stream:
        stream.write(data)
    if not unsealed:
        fcntl.fcntl(snapshot, fcntl.F_ADD_SEALS,
                    fcntl.F_SEAL_SEAL | fcntl.F_SEAL_SHRINK |
                    fcntl.F_SEAL_GROW | fcntl.F_SEAL_WRITE)
    executable = os.open(f"/proc/self/fd/{snapshot}", os.O_RDONLY)
    os.close(snapshot)
    null = os.open("/dev/null", os.O_RDONLY)
    alternate = os.open(str(DIRECTORY / "bad-report"), os.O_CREAT | os.O_WRONLY, 0o600) if report_file else None
    mapping = {0: null, 1: output_write, 2: output_write,
               4: alternate if alternate is not None else report_write,
               5: executable, 6: executable}
    high = {fd: fcntl.fcntl(source, fcntl.F_DUPFD_CLOEXEC, 40)
            for fd, source in mapping.items()}
    pid = os.fork()
    if pid == 0:
        try:
            for target, source in high.items():
                os.dup2(source, target)
            os.close(3)
            if leaked:
                os.dup2(0, 7)
            os.closerange(8 if leaked else 7, 4096)
            # Diagnostic target is an existing file in the read-only fixture
            # mount, overridden only inside this private mount namespace.
            entry = str(ROOT / "native/agenc-namespace-init.c")
            os.execve("/usr/bin/bwrap", ["bwrap", "--new-session", "--unshare-user",
                "--unshare-pid", "--unshare-net", "--die-with-parent", "--as-pid-1",
                "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc",
                "--perms", "0500", "--ro-bind-data", "6", entry,
                "--", entry, "--namespace-init-v1", *args],
                {"PATH": "/usr/bin:/bin", "LANG": "C"})
        finally:
            os._exit(126)
    for fd in [*high.values(), null, output_write, report_write, executable]:
        os.close(fd)
    if alternate is not None:
        os.close(alternate)
    deadline = time.monotonic() + timeout
    try:
        while True:
            got, status = os.waitpid(pid, os.WNOHANG)
            if got:
                break
            if time.monotonic() >= deadline:
                os.kill(pid, signal.SIGKILL)
                os.waitpid(pid, 0)
                raise AssertionError("init did not settle")
            time.sleep(.001)
        streams = {}
        for fd in [report_read, output_read]:
            assert select.select([fd], [], [], 3)[0], "pipe did not settle"
            streams[fd] = os.read(fd, 16384)
            assert select.select([fd], [], [], 3)[0], "pipe did not close"
            assert os.read(fd, 1) == b"", "unexpected extra bytes"
        frame, output = streams[report_read], streams[output_read]
        code = os.waitstatus_to_exitcode(status)
        decoded = None
        if frame:
            assert len(frame) == 16 and frame[:5] == b"AGI1\x01", frame
            kind, residual = frame[5:7]
            value = struct.unpack(">I", frame[8:12])[0]
            assert frame[7] == 0 and frame[12:] == b"\0" * 4, frame
            assert kind in (0, 1) and residual in (0, 1), frame
            assert (0 <= value <= 255 if kind == 0 else 1 <= value <= 64), frame
            assert code == (value if kind == 0 else 128 + value), (code, frame)
            decoded = {"kind": kind, "residual": residual, "value": value}
        RECORDS.append({"argv": args, "code": code, "report": decoded,
                        "frame": frame.hex(), "output": output.decode(errors="replace")})
        return code, output, decoded
    finally:
        os.close(report_read)
        os.close(output_read)


class NamespaceInit(unittest.TestCase):
    def test_normal_exit_signal_and_exec_failure(self):
        for command, code, kind, value in [
            ("printf ordinary", 0, 0, 0), ("exit 7", 7, 0, 7),
            ("exit 126", 126, 0, 126), ("exit 127", 127, 0, 127),
            ("exit 143", 143, 0, 143), ("kill -TERM $$", 143, 1, 15),
            ("kill -KILL $$", 137, 1, 9),
        ]:
            with self.subTest(command=command):
                result, output, report = invoke(["/bin/bash", "-c", command])
                self.assertEqual(result, code, output)
                self.assertEqual(report, {"kind": kind, "residual": 0, "value": value})
        code, output, report = invoke(["/does-not-exist"])
        self.assertEqual(code, 127)
        self.assertIn(b"command exec failed", output)
        self.assertEqual(report, {"kind": 0, "residual": 0, "value": 127})

    def test_ready_synchronized_leftovers(self):
        # Pipe handshake requires a real live child, without a timing grace.
        for mode in ["background", "nohup", "setsid", "double-fork", "stopped"]:
            body = r'''
import os,signal
mode=__import__('sys').argv[1]
r,w=os.pipe()
if os.fork()==0:
 os.close(r)
 if mode=='nohup':signal.signal(signal.SIGHUP,signal.SIG_IGN)
 if mode in ('setsid','double-fork'):os.setsid()
 if mode=='double-fork' and os.fork()!=0:os._exit(0)
 os.write(w,b'R');os.close(w)
 if mode=='stopped':os.kill(os.getpid(),signal.SIGSTOP)
 while True:signal.pause()
os.close(w)
assert os.read(r,1)==b'R'
os.close(r)
os._exit(0)
'''
            with self.subTest(mode=mode):
                code, output, report = invoke(["/usr/bin/python3", "-c", body, mode])
                self.assertEqual(code, 0, output)
                self.assertEqual(report, {"kind": 0, "residual": 1, "value": 0})

    def test_private_report_and_executable_are_inaccessible(self):
        body = r'''
import os,json
fds=[]
for fd in range(3,64):
 try:os.fstat(fd);fds.append(fd)
 except OSError:pass
denied=[]
for name in ['fd/4','fd/5','mem']:
 try:
  fd=os.open('/proc/1/'+name,os.O_RDWR);os.close(fd)
 except PermissionError:denied.append(name)
print(json.dumps({'fds':fds,'denied':denied}))
'''
        code, output, report = invoke(["/usr/bin/python3", "-c", body])
        self.assertEqual(code, 0, output)
        self.assertEqual(json.loads(output), {"fds": [], "denied": ["fd/4", "fd/5", "mem"]})
        self.assertEqual(report["residual"], 0)

    def test_malformed_descriptor_contract_rejected_before_command(self):
        for option in ["unsealed", "leaked", "report_file"]:
            with self.subTest(option=option):
                code, output, report = invoke(["/bin/echo", "UNEXPECTED"], **{option: True})
                self.assertEqual(code, 125, output)
                self.assertEqual(output, b"")
                self.assertIsNone(report)

    def test_ignored_sigchld_at_entry_is_reset(self):
        source = (ROOT / "native/agenc-namespace-init.c").read_text()
        source = source.replace("int main(int argc, char **argv) {",
            "int main(int argc, char **argv) {\n  signal(SIGCHLD, SIG_IGN);")
        fixture = DIRECTORY / "ignored.c"
        fixture.write_text(source)
        binary = DIRECTORY / "ignored"
        subprocess.run(["cc", "-static", "-Os", "-Wall", "-Wextra", "-Werror",
                        "-o", str(binary), str(fixture)], check=True)
        code, output, report = invoke(["/bin/true"], helper=binary)
        self.assertEqual(code, 0, output)
        self.assertEqual(report, {"kind": 0, "residual": 0, "value": 0})

    def test_pinned_contention_800_commands(self):
        self.assertTrue({0, 1}.issubset(os.sched_getaffinity(0)), "gate must expose CPUs0,1")
        os.sched_setaffinity(0, {0, 1})
        for contended in [False, True, True, False]:
            hogs = []
            try:
                if contended:
                    for cpu in [0, 1]:
                        hog = subprocess.Popen(["/usr/bin/taskset", "-c", str(cpu),
                            "/usr/bin/python3", "-c", "while True: pass"],
                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL)
                        hogs.append(hog)
                        deadline = time.monotonic() + 3
                        while os.sched_getaffinity(hog.pid) != {cpu}:
                            assert time.monotonic() < deadline
                            time.sleep(.001)
                        self.assertIsNone(hog.poll())
                for index in range(200):
                    command = "true" if index % 2 == 0 else "printf ordinary"
                    code, output, report = invoke(["/bin/bash", "-c", command])
                    RECORDS[-1].update(contended=contended, index=index)
                    self.assertEqual(code, 0, output)
                    self.assertEqual(output, b"" if index % 2 == 0 else b"ordinary")
                    self.assertEqual(report, {"kind": 0, "residual": 0, "value": 0})
                    for hog in hogs:
                        self.assertIsNone(hog.poll())
            finally:
                for hog in hogs:
                    hog.kill()
                    hog.wait()


if __name__ == "__main__":
    result = unittest.main(exit=False, verbosity=2).result
    if os.environ.get("AGENC_INIT_TEST_RECEIPT"):
        Path(os.environ["AGENC_INIT_TEST_RECEIPT"]).write_text(json.dumps({
            "passed": result.wasSuccessful(), "records": RECORDS,
            "helper_bytes": HELPER.stat().st_size,
        }, indent=2) + "\n")
    sys.exit(0 if result.wasSuccessful() else 1)
