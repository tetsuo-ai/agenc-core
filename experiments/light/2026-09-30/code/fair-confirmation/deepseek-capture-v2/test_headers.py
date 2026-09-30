"""Offline v2 header-evidence regression; no provider or listening socket."""
import json
from pathlib import Path
import unittest
from unittest.mock import patch

import test_capture as subject


class HeaderEvidenceTests(unittest.TestCase):
    def test_only_optional_capture_production_argument_changes(self):
        v1 = subject.HERE.parent / 'deepseek-capture-v1'
        before = (v1 / 'proxy.py').read_text()
        after = (subject.HERE / 'proxy.py').read_text()
        old = "capture.headers(res.status,res.headers.get('Content-Type','text/event-stream'))"
        new = "capture.headers(res.status,res.headers.get('Content-Type'))"
        self.assertEqual(before.count(old), 1)
        self.assertEqual(before.replace(old, new), after)
        for name in ('capture.py', 'fixture.py'):
            self.assertEqual((v1 / name).read_bytes(), (subject.HERE / name).read_bytes())

    def test_header_absence_is_unknown_not_downstream_fallback(self):
        for profile in ('light-flash-base-v2', 'light-flash-one-setup-v2', 'pi-flash-v0731-v2'):
            with self.subTest(profile=profile):
                case = subject.Case(self, profile)
                with patch.object(subject.Response, 'headers', {}):
                    case.run()
                receipt = json.loads((case.output / 'capture-001.json').read_bytes())
                result = case.score(case.finish())
                self.assertIsNone(receipt['content_type'])
                self.assertIsNone(result['visible_plan_format_pass'])
                self.assertFalse(result['capture_verified'])
                self.assertEqual(result['evidence_unknown_reason'], 'incomplete_transport_or_delivery')
                self.assertTrue(result['code_completion'])
                self.assertIn(('Content-Type', 'text/event-stream'), case.response_headers)

    def test_invalid_or_overlong_header_never_proves_format(self):
        for value in ('', 'application/json', 'text/event-streamx', 'x' * 257, None):
            with self.subTest(value=value):
                case = subject.Case(self)
                with patch.object(subject.Response, 'headers', {'Content-Type': value}):
                    case.run()
                result = case.score(case.finish())
                self.assertIsNone(result['visible_plan_format_pass'])
                self.assertFalse(result['capture_verified'])
                self.assertTrue(result['code_completion'])

    def test_valid_header_is_recorded_exactly_without_changing_downstream(self):
        for value in ('text/event-stream', 'text/event-stream; charset=utf-8', 'Text/Event-Stream'):
            with self.subTest(value=value):
                case = subject.Case(self)
                with patch.object(subject.Response, 'headers', {'Content-Type': value}):
                    case.run()
                receipt = json.loads((case.output / 'capture-001.json').read_bytes())
                self.assertEqual(receipt['content_type'], value)
                self.assertIn(('Content-Type', value), case.response_headers)
                self.assertTrue(case.score(case.finish())['visible_plan_format_pass'])

    def test_original_financial_and_delivery_bytes_match_for_missing_and_invalid_headers(self):
        for headers in ({}, {'Content-Type': ''}, {'Content-Type': 'application/json'}):
            with self.subTest(headers=headers), patch.object(subject.Response, 'headers', headers):
                old = subject.Case(self, original=True)
                old_handler = old.run()
                new = subject.Case(self)
                new_handler = new.run()
                for filename in ('spend.jsonl', 'deepseek-reservations.jsonl', 'usage-001.json',
                                 'wire-001.json', 'response-001.txt'):
                    self.assertEqual((old.root / filename).read_bytes(), (new.root / filename).read_bytes())
                self.assertEqual(old_handler.wfile.getvalue(), new_handler.wfile.getvalue())
                self.assertEqual(old.response_headers, new.response_headers)
                self.assertEqual(old.state['reserved'], new.state['reserved'])
                self.assertEqual(old.errors, new.errors)
                self.assertEqual(len(new.requests), 1)
                self.assertIsNone(new.score(new.finish())['visible_plan_format_pass'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
