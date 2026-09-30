"""Reviewer-owned, offline characterization of frozen Flash capture v1.

No socket or provider calls. Uses the worker's exact synthetic Case/transport;
native urlopen is forbidden by that fixture. Does not edit worker files.
"""
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

SUBJECT = Path('/private/tmp/light-takeover/fair-confirmation/deepseek-capture-v1')
sys.path.insert(0, str(SUBJECT))
import test_capture as subject


class Review(unittest.TestCase):
    def test_missing_upstream_content_type_must_remain_unknown(self):
        case = subject.Case(self)
        with patch.object(subject.Response, 'headers', {}):
            case.run()
        receipt = json.loads((case.output / 'capture-001.json').read_bytes())
        result = case.score(case.finish())
        with self.subTest(boundary='upstream_header'):
            self.assertIsNone(receipt['content_type'],
                              'upstream absence must not be replaced with downstream fallback')
        with self.subTest(boundary='planning_grade'):
            self.assertIsNone(result['visible_plan_format_pass'])

    def test_redirected_response_origin_is_currently_unattested(self):
        # Characterization only: do NOT call this a verified provider origin.
        # urllib's final-response URL is not consulted or recorded by v1.
        case = subject.Case(self)
        with patch.object(subject.Response, 'geturl', create=True,
                          return_value='https://synthetic.invalid/elsewhere') as geturl:
            case.run()
        self.assertFalse(geturl.called)
        receipt = json.loads((case.output / 'capture-001.json').read_bytes())
        self.assertNotIn('upstream_url', receipt)
        self.assertTrue(case.score(case.finish())['visible_plan_format_pass'])

    def test_first_call_tamper_after_later_complete_call_stays_unknown(self):
        case = subject.Case(self)
        case.run()
        case.run()
        capability = case.finish()
        path = case.output / 'output-001.sse'
        with path.open('ab') as handle:
            handle.write(b' ')
        result = case.score(capability)
        self.assertIsNone(result['visible_plan_format_pass'])
        self.assertTrue(result['code_completion'])

    def test_closing_owner_with_missing_ack_never_allows_later_success(self):
        case = subject.Case(self)
        case.run()
        with self.assertRaises(subject.capture.Unknown):
            case.owner.finalize(admitted_calls=2, owner_quiescent=True)
        with self.assertRaises(subject.capture.Unknown):
            case.finish()
        self.assertIsNone(case.score(None)['visible_plan_format_pass'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
