import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import evaluate


class VerificationReceiptTests(unittest.TestCase):
    def check(self, source, expected=1):
        with tempfile.TemporaryDirectory() as directory:
            suite = Path(directory) / "checks.py"
            suite.write_text(source)
            with patch.object(evaluate, "verification_command", lambda prefix, workspace, holdout, arguments: [sys.executable, *arguments]):
                return evaluate.verify_suite([], Path(directory), suite, str(suite), expected, 5)[0]

    def test_requires_completed_tests_after_successful_exit(self):
        for source in ["raise SystemExit(0)", "import os; os._exit(0)", "# no tests"]:
            with self.subTest(source=source):
                self.assertNotEqual(self.check(source), 0)

    def test_accepts_only_the_expected_number_of_passing_tests(self):
        source = "import unittest\nclass Checks(unittest.TestCase):\n def test_result(self): self.assertEqual(2 + 2, 4)\n"
        self.assertEqual(self.check(source), 0)
        self.assertEqual(self.check(source + "unittest.main()\n"), 0)
        self.assertNotEqual(self.check(source, expected=2), 0)

    def test_rejects_failures_and_skips(self):
        for body in ["self.fail('wrong')", "self.skipTest('unavailable')"]:
            with self.subTest(body=body):
                self.assertNotEqual(self.check("import unittest\nclass Checks(unittest.TestCase):\n def test_result(self): " + body + "\n"), 0)


if __name__ == "__main__":
    unittest.main()
