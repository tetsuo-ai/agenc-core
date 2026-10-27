import unittest
from report import reconcile_legacy_price


class LegacyPriceTest(unittest.TestCase):
    def test_successful_unpriced_probe_keeps_original_and_reconstructs_cost(self):
        entry = {'model': 'kimi-k3.1-pro', 'status': 200, 'cost': 0,
                 'usage': {'prompt_tokens': 2000, 'completion_tokens': 100,
                           'total_tokens': 2100, 'prompt_tokens_details': {'cached_tokens': 1000}}}
        priced = reconcile_legacy_price(entry)
        self.assertAlmostEqual(priced['cost'], .0032)
        self.assertEqual(priced['recordedCost'], 0)
        self.assertEqual(entry['cost'], 0)

    def test_refusals_and_already_priced_calls_are_preserved(self):
        for entry in ({'status': 429, 'cost': 0}, {'status': 200, 'cost': .1}):
            self.assertIs(reconcile_legacy_price(entry), entry)


if __name__ == '__main__':
    unittest.main()
