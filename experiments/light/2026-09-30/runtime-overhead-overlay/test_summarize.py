import importlib.util
import json
import pathlib
import tempfile
import unittest
spec=importlib.util.spec_from_file_location('summarize',pathlib.Path(__file__).with_name('summarize.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class IntervalTests(unittest.TestCase):
    def test_parallel_tools_are_not_double_counted(self):
        self.assertEqual(module.union_ms([(10,30),(20,40),(45,50)]),35)
    def test_post_tool_partition_does_not_double_count_nested_durability(self):
        spans=[{'name':'admission.model','start_ms':0,'duration_ms':10},
               {'name':'persistence.fsync','start_ms':2,'duration_ms':3}]
        self.assertEqual(module.post_tool_attribution([(0,12)],spans),{'admission':7,'fsync':3,'other':2})
    def test_sync_counts_require_an_actual_sync_and_choose_innermost_boundary(self):
        spans=[{'name':'persistence.flush','boundary':'outer','start_ms':0,'duration_ms':10},
               {'name':'persistence.flush','boundary':'effect_intent','start_ms':1,'duration_ms':5},
               {'name':'persistence.fsync','start_ms':2,'duration_ms':2,'count':1},
               {'name':'persistence.flush','boundary':'empty','start_ms':11,'duration_ms':1},
               {'name':'persistence.fsync','start_ms':15,'duration_ms':1,'count':1}]
        self.assertEqual(module.fsync_boundaries(spans),{'effect_intent':1,'outside_flush':1})
    def test_sync_owner_cannot_be_a_different_process(self):
        spans=[{'name':'persistence.flush','boundary':'wrong','pid':1,'start_ms':0,'duration_ms':10},
               {'name':'persistence.fsync','pid':2,'start_ms':2,'duration_ms':1,'count':1}]
        self.assertEqual(module.fsync_boundaries(spans),{'outside_flush':1})
    def test_no_tools_and_adjacent_tools(self):
        self.assertEqual(module.union_ms([]),0)
        self.assertEqual(module.union_ms([(20,30),(10,20)]),20)
    def test_existing_connection_window_excludes_priming_and_retains_rpc_cost(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory);run=root/'paired-daemon-task';run.mkdir()
            result={'mode':'daemon','start_ms':100,'end_ms':200,'wall_ms':100,
                    'daemon_stop_ms':10,'calls':2,'exit_code':0,
                    'daemon_client':{'session_create_ms':10,'teardown_ms':5,'priming_ms':500},
                    'request_boundaries':[{'request_ms':110,'response_end_ms':115},
                                          {'request_ms':160,'response_end_ms':165}]}
            spans=[{'name':'tool.invoke','tool':'priming','start_ms':0,'duration_ms':80},
                   {'name':'tool.invoke','tool':'measured','start_ms':120,'duration_ms':20}]
            (run/'result.json').write_text(json.dumps(result))
            (run/'timing.1.jsonl').write_text('\n'.join(map(json.dumps,spans)))
            group=module.summarize(root,'paired')['groups']['daemon']
            self.assertEqual(group['spans_per_task']['runtime_outside_tools'],80)
            self.assertEqual(group['boundary_mean_ms'],25)
            self.assertEqual(group['spans_per_task']['daemon.session_create'],10)
            self.assertEqual(group['spans_per_task']['daemon.session_teardown'],5)
            self.assertEqual(group['spans_per_task']['daemon.priming'],500)
            self.assertNotIn('tool.by_name.priming',group['spans_per_task'])
if __name__=='__main__':unittest.main()
