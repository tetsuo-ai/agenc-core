import importlib.util
from pathlib import Path
import subprocess
import sys
import unittest

spec = importlib.util.spec_from_file_location('ab', Path(__file__).with_name('ab.py'))
ab = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ab)


class OwnedWaitTests(unittest.TestCase):
    def test_success_reaped(self):
        child = ab.BlockingWaitPopen([sys.executable, '-c', 'pass'])
        self.assertEqual(child.wait(timeout=5), 0)
        self.assertEqual(child.poll(), 0)

    def test_failure_preserved(self):
        child = ab.BlockingWaitPopen([sys.executable, '-c', 'raise SystemExit(7)'])
        self.assertEqual(child.wait(timeout=5), 7)

    def test_timeout_kills_and_reaps_only_child(self):
        child = ab.BlockingWaitPopen([sys.executable, '-c', 'import time; time.sleep(10)'])
        with self.assertRaises(subprocess.TimeoutExpired):
            child.wait(timeout=0.05)
        self.assertIsNotNone(child.poll())
        self.assertNotEqual(child.returncode, 0)


if __name__ == '__main__':
    unittest.main()
