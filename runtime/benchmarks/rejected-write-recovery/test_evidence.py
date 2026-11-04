import copy
import json
import subprocess
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch

import analyze
import evaluate


def row(label, variant, *, task='rejected-write-blank', correct=False, exit_code=0,
        scripted=2, real=0, retries=0):
    return dict(label=label, variant=variant, task=task, id=f'{label}-{variant}',
                correctness_passed=correct, agenc_exit_code=exit_code,
                scripted_requests=scripted, real_model_requests=real,
                retry_messages=['retry'] * retries, trigger_valid=True,
                wire_valid=True, sandbox_enabled=True, supplied_tests_unchanged=True,
                verification_timed_out=False, wall_seconds=1, denied_permissions=[])


def complete_study():
    rows = []
    for _ in range(5):
        rows += [row('trigger-confirmation', 'before'),
                 row('trigger-confirmation', 'after', correct=True, real=1, retries=1)]
    rows += [row('persistent-confirmation', 'before'),
             row('persistent-confirmation', 'after', exit_code=4, scripted=5, retries=3)]
    for task in ['csv-bugfix', 'sqlite-cli']:
        for variant in ['before', 'after']:
            rows += [row('natural-confirmation', variant, task=task,
                         correct=True, scripted=0, real=1) for _ in range(3)]
    return rows


class EvidenceContract(unittest.TestCase):
    def test_incomplete_confirmation_cannot_pass(self):
        rows = complete_study()
        self.assertTrue(analyze.analyze(rows)['spark_gates_passed'])
        rows.pop()
        self.assertFalse(analyze.analyze(rows)['spark_gates_passed'])

    def test_successful_pilot_cannot_replace_failed_confirmation(self):
        rows = complete_study()
        rows[1]['correctness_passed'] = False
        pilot = copy.deepcopy(rows[1])
        pilot.update(label='pilot-v2', correctness_passed=True)
        result = analyze.analyze(rows + [pilot])
        self.assertFalse(result['gates']['trigger'])
        self.assertEqual(result['trigger_confirmation']['after']['correct'], 4)
        self.assertEqual(len(result['pilots_excluded']), 1)

    def test_permission_exit_is_retained_separately_from_code_correctness(self):
        rows = complete_study()
        rows[-1].update(agenc_exit_code=2, denied_permissions=['denied'])
        result = analyze.analyze(rows)
        self.assertEqual(result['natural_confirmation']['after']['correct'], 6)
        self.assertEqual(result['natural_confirmation']['after']['exit_zero'], 5)
        self.assertEqual(result['natural_confirmation']['after']['nonzero_exits'][0]['exit_code'], 2)

    def test_partial_daemon_start_is_stopped_on_timeout(self):
        calls = []

        def command(argv, **kwargs):
            calls.append(argv)
            if "doctor" in argv:
                return subprocess.CompletedProcess(argv, 0, json.dumps({"sandbox": {"kind": "ready"}}), "")
            if "restart" in argv:
                raise subprocess.TimeoutExpired(argv, 45)
            return subprocess.CompletedProcess(argv, 0, b"", b"")

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = root / "fixtures.json"
            fixture.write_text("{}")
            argv = ["evaluate.py", "--root", str(root / "work"), "--home-root", str(root / "homes"),
                    "--fixtures", str(fixture), "--before", str(root / "agenc"),
                    "--node", str(root / "node"), "--variants", "before"]
            with patch.object(evaluate.sys, "argv", argv), patch.object(evaluate, "run_check", return_value=(0, "", False)), patch.object(evaluate.subprocess, "run", side_effect=command):
                with self.assertRaises(subprocess.TimeoutExpired):
                    evaluate.main()
        self.assertTrue(any(argv[-2:] == ["daemon", "stop"] for argv in calls))

    def test_zero_exit_without_expected_suite_receipt_is_not_a_pass(self):
        for log in ['', 'AGENC_CHECK_RESULT={"passed": true, "tests_run": 2}\n']:
            with self.subTest(log=log), patch.object(evaluate, 'run_check', return_value=(0, log, False)), patch.object(evaluate, 'verification_command', return_value=['unused']):
                code, _, _ = evaluate.verify_suite([], None, None, 'suite', 3, 1)
                self.assertNotEqual(code, 0)


if __name__ == '__main__':
    unittest.main()
