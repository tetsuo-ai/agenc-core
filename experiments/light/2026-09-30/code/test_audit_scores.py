import copy
import unittest
from audit_scores import audit, report


class ScoreAuditTests(unittest.TestCase):
    def test_does_not_mutate_evidence(self):
        row = {'task': '12-partition-map', 'agent': 'pi', 'pass': True,
               'symmetric_pass': False, 'symmetric_evidence': {'successful_plan_calls': 0}}
        before = copy.deepcopy(row)
        audit(row)
        self.assertEqual(row, before)

    def test_pi_missing_tool_not_comparable(self):
        self.assertIsNone(audit({'task': '12-partition-map', 'agent': 'pi'})['tool_requirement_comparable'])

    def test_light_success_not_comparable_either(self):
        self.assertIsNone(audit({'task': '12-partition-map', 'agent': 'light',
                                 'symmetric_pass': True})['tool_requirement_comparable'])

    def test_check_pass_not_mislabelled_code(self):
        self.assertIsNone(audit({'check_pass': True})['coding_pass'])

    def test_timeout_retained(self):
        self.assertFalse(audit({'coding_pass': True, 'exit_code': 0,
                                'timeout': True})['coding_completion'])

    def test_code_failure_retained(self):
        self.assertFalse(audit({'coding_pass': False, 'exit_code': 0})['coding_completion'])

    def test_code_success(self):
        self.assertTrue(audit({'coding_pass': True, 'exit_code': 0})['coding_completion'])

    def test_other_task_unchanged(self):
        row = audit({'task': '03-window-padding', 'pass': False})
        self.assertFalse(row['recorded_pass'])
        self.assertTrue(row['tool_requirement_comparable'])

    def test_unknown_not_counted_as_failure_or_success(self):
        result = report([{'task': '12-partition-map', 'agent': 'pi'}], 'hash')
        self.assertEqual(result['task12']['pi']['recorded_passes'], 0)
        self.assertEqual(result['task12']['pi']['missing_separate_coding_score'], 1)


if __name__ == '__main__':
    unittest.main()
