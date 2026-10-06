"""AGB3 report-fault controls, using temporary compile-time fixture mutations.

No production fault switches, caller-selected report FDs, or weakened helper
verification. Every modified static image is sealed and compared normally.
"""
from pathlib import Path
import importlib.util
import json
import os
import subprocess
import unittest

spec = importlib.util.spec_from_file_location(
    "v3", Path(__file__).with_name("process-broker-v3.kernel.py"))
v3 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v3)
SOURCE = (v3.ROOT / "native/agenc-namespace-init.c").read_text()
WRITE = "do { count = write(REPORT_FD, frame, sizeof(frame)); }"
assert SOURCE.count(WRITE) == 1


def compile_variant(source):
    fixture = v3.D / "init-fixture.c"
    fixture.write_text(source)
    subprocess.run(["cc", "-static", "-Os", "-std=c11", "-Wall", "-Wextra", "-Werror",
                    "-o", str(v3.HELPER), str(fixture)], check=True)
    v3.HEADER.write_text("static const unsigned char agenc_namespace_init_image[] = {" +
                         ",".join(str(x) for x in v3.HELPER.read_bytes()) + "};\n")
    subprocess.run(["cc", "-O2", "-std=c11", "-Wall", "-Wextra", "-Werror",
                    '-DAGENC_NAMESPACE_INIT_IMAGE_HEADER="' + str(v3.HEADER) + '"',
                    "-o", str(v3.BROKER), str(v3.ROOT / "native/agenc-process-broker.c")], check=True)


class ReportFaults(unittest.TestCase):
    def test_malformed_reports_preserve_cleanup_but_never_success_or_replay(self):
        variants = [
            ("missing", "do { count = 0; }"),
            ("truncated", "do { count = write(REPORT_FD, frame, sizeof(frame) - 1); }"),
            ("short-write", "do { count = write(REPORT_FD, frame, 1); }"),
            ("write-failure", "do { count = -1; errno = EIO; }"),
            ("extra", 'do { if (write(REPORT_FD, "X", 1) != 1) return false; count = write(REPORT_FD, frame, sizeof(frame)); }'),
            ("bad-magic", "frame[0] ^= 128; " + WRITE),
            ("bad-version", "frame[4] = 2; " + WRITE),
            ("reserved", "frame[15] = 1; " + WRITE),
            ("bad-residual", "frame[6] = 2; " + WRITE),
            ("bad-kind", "frame[5] = 2; " + WRITE),
            ("signal-zero", "frame[5] = 1; frame[11] = 0; " + WRITE),
            ("oversize-exit", "frame[10] = 1; " + WRITE),
            ("root-status-mismatch", "frame[11] = 7; " + WRITE),
        ]
        try:
            for name, replacement in variants:
                with self.subTest(name=name):
                    compile_variant(SOURCE.replace(WRITE, replacement))
                    code, output, proof = v3.invoke(["/bin/bash", "-c", "printf EFFECT"])
                    v3.RECORDS[-1]["fault"] = name
                    self.assertEqual(output, b"EFFECT", "the effect ran exactly once")
                    self.assertEqual(code, 125)
                    self.assertEqual(proof, v3.expected(state=2, residual=2, kind=2))
        finally:
            compile_variant(SOURCE)

    def test_interrupted_report_write_retries_only_the_report(self):
        compile_variant(SOURCE.replace(WRITE,
            "unsigned attempts = 0; do { if (attempts++ == 0) { count = -1; errno = EINTR; } "
            "else count = write(REPORT_FD, frame, sizeof(frame)); }"))
        try:
            code, output, proof = v3.invoke(["/bin/bash", "-c", "printf EFFECT"])
            self.assertEqual((code, output, proof), (0, b"EFFECT", v3.expected()))
        finally:
            compile_variant(SOURCE)


if __name__ == "__main__":
    result = unittest.main(exit=False, verbosity=2).result
    if os.environ.get("AGENC_BROKER_V3_TEST_RECEIPT"):
        Path(os.environ["AGENC_BROKER_V3_TEST_RECEIPT"]).write_text(json.dumps({
            "passed": result.wasSuccessful(), "records": v3.RECORDS,
        }, indent=2) + "\n")
    raise SystemExit(0 if result.wasSuccessful() else 1)
