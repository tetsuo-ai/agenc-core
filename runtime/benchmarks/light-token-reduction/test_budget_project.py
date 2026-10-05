import copy
import unittest

from budget_project import head, project_budget, replace_head, selected_names, summarize
from test_round2_project import Audit, body


def fixture():
    old = dict(workflow='old workflow', system='old system', actions_deepseek='old actions',
               actions_openai='old lean actions', deadline='old deadline')
    new = {k: v.replace('old', 'budget') for k, v in old.items()}
    return dict(legacy_sections=old, sections=new,
                initial_tool_names=['FileRead', 'exec_command', 'system.searchTools'],
                fixtures={'deepseek': {'tools': []}, 'luna': {'tools': []}})


class BudgetProjectionTests(unittest.TestCase):
    def test_preserves_provider_prefix_deadline_dynamic_tail_and_history(self):
        p = fixture()
        for model in ('deepseek', 'luna'):
            for deadline in (False, True):
                b = body()
                text = 'provider prefix\n\n' + head(p['legacy_sections'], model)
                if deadline:
                    text += '\n\nold deadline'
                text += '\n\nauthority tail'
                if model == 'luna':
                    b['instructions'] = text
                else:
                    b['messages'].insert(0, dict(role='system', content=text))
                original = copy.deepcopy(b)
                out = replace_head(b, p, model)
                got = out.get('instructions') or out['messages'][0]['content']
                self.assertTrue(got.startswith('provider prefix\n\nbudget workflow'))
                self.assertTrue(got.endswith('\n\nauthority tail'))
                self.assertEqual('budget deadline' in got, deadline)
                self.assertEqual(out['messages'][-2:], original['messages'][-2:])
                self.assertEqual(out['tools'], original['tools'])
                self.assertEqual(b, original)

    def test_rejects_unknown_or_ambiguous_heads(self):
        p = fixture()
        for text in ('unrecognized', head(p['legacy_sections'], 'deepseek') * 2):
            with self.assertRaises(ValueError):
                replace_head(dict(instructions=text), p, 'deepseek')

    def test_full_exposure_charges_deferred_schemas_and_preserves_unknowns(self):
        p = fixture(); b = body()
        b['instructions'] = head(p['legacy_sections'], 'deepseek')
        b['tools'].extend({'type': 'function', 'function': {'name': name}} for name in ('Edit', 'Write', 'Grep', 'Glob'))
        full = project_budget(b, p, 'deepseek', Audit)
        names = lambda out: [t['function']['name'] for t in out['tools']]
        self.assertEqual(names(full), ['exec_command', 'external', 'Edit', 'Write', 'Grep', 'Glob'])
        oracle = project_budget(b, p, 'deepseek', Audit, demand_names={'Write'})
        self.assertEqual(names(oracle), ['exec_command', 'external', 'Write'])
        self.assertEqual(oracle['messages'], b['messages'])

    def test_explicit_discovery_is_charged_even_without_oracle_demand(self):
        b = body()
        b['messages'][0]['tool_calls'][0]['function'] = {
            'name': 'tool2__system_x2esearchTools',
            'arguments': '{"select":["Write"],"query":"select:Grep"}'}
        self.assertEqual(selected_names(b, Audit), {'Write', 'Grep'})

    def test_restarted_and_partial_censuses_stay_separate(self):
        def run(panel, task, complete, delta):
            return dict(model='luna', panel=panel, task=task, complete=complete, requests=[{}],
                        totals=dict(baseline_9e61=100, baseline_97b=90,
                                    full_exposure=100+delta, first_use_oracle=95+delta))
        rows=summarize([run('a', 'T001', True, -20), run('a', 'T001', True, -40),
                        run('a', 'T002', True, -50), run('b', 'T001', True, -90),
                        run('a', 'T003', False, -10)])
        self.assertEqual(len(rows), 3)
        original=next(r for r in rows if r['panel']=='a' and r['complete'])
        self.assertEqual((original['trajectories'], original['unique_tasks']), (3, 2))
        self.assertEqual(original['comparisons']['baseline_9e61_to_full_exposure']['mean_delta_per_task_cluster'], -40)
        partial=next(r for r in rows if not r['complete'])
        self.assertIsNone(partial['comparisons']['baseline_97b_to_first_use_oracle']['descriptive_fixed_trace_task_cluster_ci95'])


if __name__ == '__main__':
    unittest.main()
