"""Independent frozen-v1/v2 header characterization, synthetic transport only.

Run each version in a fresh interpreter to avoid cross-version module caches.
The imported Case forbids native urlopen and creates only temporary fixtures.
"""
import hashlib
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

VERSION = sys.argv.pop(1)
PINS = {
    'v1': 'a8f73064656d4329e48dc6df160122f453266d525283d906b04c48e78f2e7118',
    'v2': '9377a87555baabdb05aef06d026b68d807ce97db8352fb6fdd9c5f3aca2f5f5f',
}
if VERSION not in PINS:
    raise ValueError('only frozen v1 or v2 supported')
ROOT = Path('/private/tmp/light-takeover/fair-confirmation')
SUBJECT = ROOT / ('deepseek-capture-' + VERSION)
if hashlib.sha256((SUBJECT / 'proxy.py').read_bytes()).hexdigest() != PINS[VERSION]:
    raise ValueError('source snapshot changed')
sys.path.insert(0, str(SUBJECT))
import test_capture as subject


class HeaderReview(unittest.TestCase):
    def test_absence_reproduces_v1_false_positive_and_v2_unknown(self):
        for profile in ('light-flash-base-v2', 'light-flash-one-setup-v2', 'pi-flash-v0731-v2'):
            with self.subTest(profile=profile):
                case = subject.Case(self, profile)
                with patch.object(subject.Response, 'headers', {}):
                    case.run()
                result = case.score(case.finish())
                receipt = json.loads((case.output / 'capture-001.json').read_bytes())
                if VERSION == 'v1':
                    self.assertEqual(receipt['content_type'], 'text/event-stream')
                    self.assertIs(result['visible_plan_format_pass'], True)
                    self.assertTrue(result['capture_verified'])
                else:
                    self.assertIsNone(receipt['content_type'])
                    self.assertIsNone(result['visible_plan_format_pass'])
                    self.assertFalse(result['capture_verified'])
                    self.assertEqual(result['evidence_unknown_reason'], 'incomplete_transport_or_delivery')
                    self.assertEqual(case.response_headers, [('Content-Type', 'text/event-stream')])
                self.assertTrue(result['code_completion'])
                self.assertEqual(len(case.requests), 1)

    def test_original_finance_and_delivery_are_retained(self):
        for headers in ({}, {'Content-Type': ''}, {'Content-Type': 'application/json'},
                        {'Content-Type': 'text/event-stream; charset=UTF-8'}):
            with self.subTest(headers=headers), patch.object(subject.Response, 'headers', headers):
                original = subject.Case(self, original=True)
                original_handler = original.run()
                candidate = subject.Case(self)
                candidate_handler = candidate.run()
                for name in ('spend.jsonl', 'deepseek-reservations.jsonl', 'usage-001.json',
                             'wire-001.json', 'response-001.txt'):
                    self.assertEqual((original.root / name).read_bytes(), (candidate.root / name).read_bytes())
                self.assertEqual(original_handler.wfile.getvalue(), candidate_handler.wfile.getvalue())
                self.assertEqual(original.requests[0].data, candidate.requests[0].data)
                self.assertEqual(original.state['reserved'], candidate.state['reserved'])
                self.assertEqual(original.ns['pending_reservations'](), candidate.ns['pending_reservations']())
                self.assertEqual(original.errors, candidate.errors)
                if VERSION == 'v2':
                    self.assertEqual(original.response_headers, candidate.response_headers)

    def test_explicit_sse_positive_control_remains_valid(self):
        case = subject.Case(self)
        case.run()
        self.assertTrue(case.score(case.finish())['visible_plan_format_pass'])
        self.assertIsNone(case.score(None)['visible_plan_format_pass'])

    def test_v2_diff_is_only_optional_metadata_argument(self):
        before = (ROOT / 'deepseek-capture-v1/proxy.py').read_bytes()
        after = (ROOT / 'deepseek-capture-v2/proxy.py').read_bytes()
        old = b"capture.headers(res.status,res.headers.get('Content-Type','text/event-stream'))"
        new = b"capture.headers(res.status,res.headers.get('Content-Type'))"
        self.assertEqual(before.count(old), 1)
        self.assertEqual(before.replace(old, new), after)
        for name in ('capture.py', 'fixture.py'):
            self.assertEqual((ROOT / 'deepseek-capture-v1' / name).read_bytes(),
                             (ROOT / 'deepseek-capture-v2' / name).read_bytes())


if __name__ == '__main__':
    unittest.main(verbosity=2)
