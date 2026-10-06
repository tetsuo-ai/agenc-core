"""Real-kernel cancellation boundaries, with compile-time-only fixture hooks."""
from pathlib import Path
import importlib.util
import json
import os
import signal
import subprocess
import time
import unittest

spec = importlib.util.spec_from_file_location(
    "v3", Path(__file__).with_name("process-broker-v3.kernel.py"))
v3 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v3)
INIT = (v3.ROOT / "native/agenc-namespace-init.c").read_text()
BROKER = (v3.ROOT / "native/agenc-process-broker.c").read_text()
WORK = v3.D / "work"
WORK.mkdir()
marker = WORK / "checkpoint"
release = WORK / "release"
os.mkfifo(release, 0o600)


def replace_once(text, before, after):
    assert text.count(before) == 1, (before, text.count(before))
    return text.replace(before, after)


def compile_variant(helper=INIT, broker=BROKER):
    source = v3.D / "init-fixture.c"
    source.write_text(helper)
    subprocess.run(["cc", "-static", "-Os", "-std=c11", "-Wall", "-Wextra", "-Werror",
                    "-o", str(v3.HELPER), str(source)], check=True)
    v3.HEADER.write_text("static const unsigned char agenc_namespace_init_image[] = {" +
                         ",".join(str(x) for x in v3.HELPER.read_bytes()) + "};\n")
    source = v3.D / "broker-fixture.c"
    source.write_text(broker)
    subprocess.run(["cc", "-O2", "-std=c11", "-Wall", "-Wextra", "-Werror",
                    '-DAGENC_NAMESPACE_INIT_IMAGE_HEADER="' + str(v3.HEADER) + '"',
                    "-o", str(v3.BROKER), str(source)], check=True)


def checkpoint_code():
    return f'''
static void checkpoint(void) {{
  int fd = open("{marker}", O_WRONLY | O_CREAT | O_EXCL, 0600);
  if (fd < 0 || write(fd, "R", 1) != 1 || close(fd) != 0) _exit(124);
  fd = open("{release}", O_RDONLY);
  char byte;
  if (fd < 0 || read(fd, &byte, 1) != 1 || close(fd) != 0) _exit(124);
}}
'''


def await_marker(path):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if path.exists() and path.stat().st_size:
            return
        time.sleep(.002)
    raise AssertionError("checkpoint was not reached: " + str(path))


def cancel_at_checkpoint(pid):
    await_marker(marker)
    os.kill(pid, signal.SIGTERM)
    # Never wait for the helper to consume the release: cancellation may
    # already have killed it. The broker's controls remain blocked until its
    # real final classifier or signal-wait loop observes the pending signal.
    fd = os.open(release, os.O_RDWR | os.O_NONBLOCK)
    os.write(fd, b"R")
    os.close(fd)


class Cancellation(unittest.TestCase):
    def tearDown(self):
        marker.unlink(missing_ok=True)
        release.unlink()
        os.mkfifo(release, 0o600)

    def test_cancellation_at_helper_report_boundaries(self):
        write = "do { count = write(REPORT_FD, frame, sizeof(frame)); }"
        for phase, replacement in [
            ("before", "checkpoint(); " + write),
            ("during", "do { if (write(REPORT_FD, frame, 8) != 8) return false; "
                       "checkpoint(); count = write(REPORT_FD, frame + 8, 8); }"),
            ("after", "do { count = write(REPORT_FD, frame, sizeof(frame)); checkpoint(); }"),
        ]:
            with self.subTest(phase=phase):
                helper = replace_once(INIT, "static bool report_result",
                                      checkpoint_code() + "\nstatic bool report_result")
                compile_variant(replace_once(helper, write, replacement))
                code, output, proof = v3.invoke(["/bin/sh", "-c", "printf EFFECT"],
                    mutations=lambda args: args + ["--bind", str(WORK), str(WORK)],
                    on_ready=cancel_at_checkpoint)
                v3.RECORDS[-1]["phase"] = phase
                self.assertEqual(output, b"EFFECT")
                # A complete, matching report may win the cancellation race.
                # Otherwise the broker must prove cleanup and report abort;
                # a partial helper report can never authenticate success.
                allowed = [(125, v3.expected(state=1, residual=2, kind=2))]
                if phase != "during":
                    allowed.append((0, v3.expected()))
                self.assertIn((code, proof), allowed)
                marker.unlink()
                release.unlink()
                os.mkfifo(release, 0o600)

    def test_pending_cancel_at_final_classification(self):
        for valid in [False, True]:
            with self.subTest(valid=valid):
                helper = INIT if valid else replace_once(INIT,
                    "do { count = write(REPORT_FD, frame, sizeof(frame)); }",
                    "do { count = 0; }")
                broker = replace_once(BROKER, "static int complete_v3_cleanup(int root_status) {",
                    checkpoint_code() + "\nstatic int complete_v3_cleanup(int root_status) {")
                broker = replace_once(broker, "  unsigned char terminal[12] =",
                    "  checkpoint();\n  unsigned char terminal[12] =")
                compile_variant(helper, broker)
                code, output, proof = v3.invoke(["/bin/sh", "-c", "printf EFFECT"],
                    on_ready=cancel_at_checkpoint)
                v3.RECORDS[-1]["pending_with_valid_report"] = valid
                self.assertEqual(output, b"EFFECT")
                self.assertEqual((code, proof), (0, v3.expected()) if valid else
                    (125, v3.expected(state=1, residual=2, kind=2)))
                marker.unlink()
                release.unlink()
                os.mkfifo(release, 0o600)

    def test_graceful_signal_matches_legacy_sandbox_route_and_stdio(self):
        compile_variant()
        ready, signals = WORK / "ready", WORK / "signals"
        # A command waits in its own process without a child that could race
        # namespace init. The async-safe handler persists each delivery.
        target_source, target = WORK / "target.c", WORK / "target"
        target_source.write_text(r'''
#include <fcntl.h>
#include <signal.h>
#include <unistd.h>
static int record;
static void stop(int signo) { (void)signo; char c = 'T'; if (write(record, &c, 1) != 1) _exit(124); }
int main(int argc, char **argv) {
  if (argc != 3) return 124;
  record = open(argv[2], O_WRONLY | O_CREAT | O_APPEND, 0600);
  if (record < 0 || signal(SIGTERM, stop) == SIG_ERR) return 124;
  int fd = open(argv[1], O_WRONLY | O_CREAT, 0600);
  if (fd < 0 || write(fd, "R", 1) != 1 || close(fd) != 0) return 124;
  pause();
  /* Stay alive until forced cleanup so a duplicate delivery is observable. */
  for (;;) pause();
}
''')
        subprocess.run(["cc", "-O2", "-Wall", "-Wextra", "-Werror", "-o", str(target),
                        str(target_source)], check=True)

        def stop(pid):
            await_marker(ready)
            os.kill(pid, signal.SIGTERM)

        observed = {}
        for protocol in ["v2", "v3"]:
            code, output, proof = v3.invoke([str(target), str(ready), str(signals)],
                mutations=lambda args: args + ["--bind", str(WORK), str(WORK)],
                on_ready=stop, protocol=protocol)
            observed[protocol] = signals.read_bytes()
            v3.RECORDS[-1]["protocol"] = protocol
            v3.RECORDS[-1]["task_graceful_deliveries"] = len(observed[protocol])
            if protocol == "v3":
                self.assertEqual((code, proof), (125, v3.expected(state=1, residual=2, kind=2)), output)
            else:
                self.assertIn(proof, [b"SC", b"SRC"])
            ready.unlink()
            signals.unlink()
        # bwrap --new-session puts the command in a different group from its
        # outer monitor. This compares that existing sandbox route honestly;
        # it does not assert that one graceful signal reaches the command.
        self.assertEqual(observed["v3"], observed["v2"])
        self.assertLessEqual(len(observed["v3"]), 1)
        code, output, proof = v3.invoke(
            ["/bin/sh", "-c", 'read -r line; printf "out:%s" "$line"; printf err >&2; exit 126'],
            stdin_data=b"input\n")
        self.assertEqual((code, output, proof), (126, b"out:inputerr", v3.expected(code=126)))
        code, output, proof = v3.invoke(["/does-not-exist"])
        self.assertEqual((code, proof), (127, v3.expected(code=127)))
        self.assertIn(b"command exec failed", output)


if __name__ == "__main__":
    result = unittest.main(exit=False, verbosity=2).result
    if os.environ.get("AGENC_BROKER_V3_TEST_RECEIPT"):
        Path(os.environ["AGENC_BROKER_V3_TEST_RECEIPT"]).write_text(json.dumps({
            "passed": result.wasSuccessful(), "records": v3.RECORDS,
        }, indent=2) + "\n")
    raise SystemExit(0 if result.wasSuccessful() else 1)
