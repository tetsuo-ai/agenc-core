#!/usr/bin/env python3
"""Offline accounting checks. No credentials, network, provider or signal use."""
import copy
import datetime
import json
from pathlib import Path
import unittest
from reconcile_budget import reconcile_record, request_rates

PRICING = json.loads(Path(__file__).with_name('pricing.json').read_text())


def fixture(model='deepseek-v4-pro', hour=11):
    body = {'model': model, 'messages': [{'role': 'user', 'content': 'hello'}], 'max_tokens': 8192}
    stamp = datetime.datetime(2026, 9, 29, hour, tzinfo=datetime.timezone.utc).timestamp()
    record = {'run': 'baseline-example', 'call': 1, 'model': model, 'time': stamp,
              'usage_missing': True, 'usage': {}, 'input_tokens': 0, 'output_tokens': 0, 'cost_usd': 0,
              'rates': [float(x) for x in request_rates(model, stamp, PRICING)],
              'budget_charge_usd': (len(json.dumps(body)) * 1.32 + 8192 * 3.96) / 1e6}
    return record, body


class ReconciliationTests(unittest.TestCase):
    def test_peak_pro_unchanged(self):
        record, body = fixture(hour=8)
        self.assertEqual(reconcile_record(record, body, PRICING), record)

    def test_off_peak_pro_retains_half_price_upper_bound_and_unknown_usage(self):
        record, body = fixture()
        before = copy.deepcopy(record)
        result = reconcile_record(record, body, PRICING)
        self.assertEqual(record, before)
        self.assertGreaterEqual(result['budget_charge_usd'], record['budget_charge_usd'] / 2)
        self.assertLess(result['budget_charge_usd'], record['budget_charge_usd'] / 2 + 1e-9)
        self.assertTrue(result['usage_missing'])
        self.assertEqual(result['cost_usd'], 0)

    def test_flash_uses_both_correct_rates(self):
        record, body = fixture(model='deepseek-flash')
        expected = (len(json.dumps(body)) * .15 + 8192 * .6) / 1e6
        result = reconcile_record(record, body, PRICING)
        self.assertGreaterEqual(result['budget_charge_usd'], expected)
        self.assertLess(result['budget_charge_usd'], expected + 1e-9)

    def test_measured_records_are_not_repriced(self):
        record, body = fixture()
        record.update(usage_missing=False, cost_usd=.123, budget_charge_usd=.123)
        self.assertEqual(reconcile_record(record, body, PRICING), record)

    def test_rejects_inconsistent_rates(self):
        record, body = fixture()
        record['rates'][1] = 0
        with self.assertRaisesRegex(ValueError, 'rates'):
            reconcile_record(record, body, PRICING)

    def test_rejects_wrong_reserve(self):
        record, body = fixture()
        record['budget_charge_usd'] *= 2
        with self.assertRaisesRegex(ValueError, 'Reserve'):
            reconcile_record(record, body, PRICING)

    def test_rejects_model_mismatch_and_conflicting_usage(self):
        record, body = fixture()
        with self.assertRaisesRegex(ValueError, 'models'):
            reconcile_record(record, body | {'model': 'deepseek-flash'}, PRICING)
        with self.assertRaisesRegex(ValueError, 'conflicting'):
            reconcile_record(record | {'output_tokens': 1}, body, PRICING)

    def test_rejects_unbounded_output(self):
        record, body = fixture()
        with self.assertRaisesRegex(ValueError, 'output cap'):
            reconcile_record(record, body | {'max_tokens': 999999}, PRICING)
        del body['max_tokens']
        with self.assertRaisesRegex(ValueError, 'output cap'):
            reconcile_record(record, body, PRICING)


if __name__ == '__main__':
    unittest.main()
