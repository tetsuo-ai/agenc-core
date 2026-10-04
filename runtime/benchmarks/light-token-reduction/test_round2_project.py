import copy
import unittest
from round2_project import project_body, stdin_exposed, similarity, summarize_runs

class Audit:
    @staticmethod
    def items(b):return b.get('messages',[])
    @staticmethod
    def call_records(b):return {c['id']:c['function'] for m in b.get('messages',[]) for c in m.get('tool_calls',[])}

def body(output='AGENC_DATA\ndone\n\n[exec exit_code=0]\nAGENC_DATA'):
    return {'tools':[{'type':'function','function':{'name':n,'description':'original','parameters':{'type':'object'}}} for n in ('exec_command','write_stdin','external')],
        'messages':[{'role':'assistant','reasoning_content':'unchanged','tool_calls':[{'id':'a','function':{'name':'exec_command','arguments':'{"cmd":"pwd"}'}}]},
            {'role':'tool','tool_call_id':'a','content':output}]}

class ProjectionTests(unittest.TestCase):
    def test_restarted_panels_and_partial_attempts_are_not_pooled(self):
        def run(panel, task, delta, complete=True):
            return dict(model='deepseek', panel=panel, task=task, complete=complete,
                        requests=[{}], totals=dict(baseline=100, stdin=100+delta,
                                                   descriptions=100+delta, combined=100+delta))
        rows=summarize_runs([run('original','T001',-10), run('original','T001',-30),
                             run('original','T002',-40), run('restart','T001',-80),
                             run('original','T003',-2,False)])
        self.assertEqual(len(rows),3)
        original=next(r for r in rows if r['panel']=='original' and r['complete'])
        self.assertEqual((original['trajectories'],original['unique_tasks']),(3,2))
        self.assertEqual(original['mechanisms']['combined']['mean_delta_per_task_cluster'],-30)
        restart=next(r for r in rows if r['panel']=='restart')
        self.assertIsNone(restart['mechanisms']['combined']['descriptive_fixed_trace_task_cluster_ci95'])

    def test_preserves_all_history_and_unknown_schema(self):
        source=body();before=copy.deepcopy(source)
        export={'fixtures':{'deepseek':{'tools':[{'type':'function','function':{'name':'exec_command','description':'compact','parameters':{'type':'object'}}}]}}}
        projected=project_body(source,export,'deepseek',Audit)
        self.assertEqual(projected['messages'],source['messages'])
        self.assertEqual(projected['tools'][-1],source['tools'][-1])
        self.assertEqual(len(projected['tools']),2)
        self.assertEqual(source,before)
        self.assertEqual(len(project_body(source,export,'deepseek',Audit,exposed=True)['tools']),3)

    def test_actual_last_footer_controls_projection(self):
        self.assertTrue(stdin_exposed(body('AGENC_DATA\nx\n\n[exec yielded=true wall_time=1.0000s tokens=1 session_id=71]\nAGENC_DATA'),Audit))
        self.assertFalse(stdin_exposed(body('AGENC_DATA\n[exec yielded=true session_id=999]\n\n[exec exit_code=0]\nAGENC_DATA'),Audit))
        self.assertFalse(stdin_exposed(body('AGENC_DATA\nx\n[exec running=true pid=10 detached=true]\nAGENC_DATA'),Audit))

    def test_manual_discovery_counts_as_exposed(self):
        b=body();b['messages'][0]['tool_calls'][0]['function']={'name':'tool2__system_x2esearchTools','arguments':'{"select":["write_stdin"]}'}
        self.assertTrue(stdin_exposed(b,Audit))

    def test_similarity_reports_overlap_without_reference_text(self):
        s=similarity('a b c d e f g h i','a b c d e f g h j')
        self.assertEqual(s['common_unique_8grams'],1)
        self.assertEqual(s['longest_common_word_run'],8)

if __name__=='__main__':unittest.main()
