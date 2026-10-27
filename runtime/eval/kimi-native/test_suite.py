import unittest
from suite import stress_target, stress_case


class StressBudgetTest(unittest.TestCase):
    def ledger(self, spent, usage, balance):
        return {'cap': 24, 'balanceFloor': 1, 'spent': spent, 'priorSpend': 0.2,
                'usageSpend': usage, 'lastBalance': {'available_balance': balance}}

    def test_context_and_budget_both_limit_stress(self):
        self.assertEqual(stress_target(self.ledger(1, 1, 24), 1048576), 500000)
        self.assertEqual(stress_target(self.ledger(1, 1, 24), 262144), 200000)
        self.assertLess(stress_target(self.ledger(20, 20, 5), 1048576), 96000)

    def test_delayed_billing_cannot_fund_another_large_request(self):
        self.assertLess(stress_target(self.ledger(1, 20, 24), 1048576), 96000)
        self.assertLess(stress_target(self.ledger(1, 1, 1.2), 1048576), 96000)

    def test_remaining_target_uses_shorter_tasks_without_relaxing_wire_limits(self):
        self.assertEqual(stress_case(self.ledger(20, 20, 5), 1048576, 150), ('replay', {}))
        self.assertEqual(stress_case(self.ledger(1, 1, 24), 1048576, 100),
                         ('long-context', {'seed': 100, 'target_tokens': 500000}))


if __name__ == '__main__':
    unittest.main()
