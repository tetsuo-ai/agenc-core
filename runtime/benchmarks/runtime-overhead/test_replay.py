import importlib.util
import json
import pathlib
import unittest
spec=importlib.util.spec_from_file_location('replay',pathlib.Path(__file__).with_name('replay.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class ReplayTests(unittest.TestCase):
    def test_a_poll_uses_the_handle_returned_by_the_matching_live_tool(self):
        reply={'tool_calls':[{'id':'poll','function':{'name':'write_stdin','arguments':'{"session_id":16,"chars":""}'}}]}
        body={'messages':[{'role':'tool','tool_call_id':'other','content':'session_id=99'},
                          {'role':'tool','tool_call_id':'exec','content':'[exec yielded=true session_id=23]'}]}
        mapped=m.map_poll_sessions(body,reply,{'exec':16},{})
        self.assertEqual(json.loads(mapped['tool_calls'][0]['function']['arguments'])['session_id'],23)
        self.assertEqual(json.loads(reply['tool_calls'][0]['function']['arguments'])['session_id'],16)
    def test_unmatched_handles_fail_instead_of_polling_an_unrelated_process(self):
        reply={'tool_calls':[{'id':'poll','function':{'name':'write_stdin','arguments':'{"session_id":16}'}}]}
        with self.assertRaises(RuntimeError):m.map_poll_sessions({'messages':[]},reply,{'exec':16},{})
    def test_only_recorded_polled_commands_get_an_early_yield(self):
        replies=[{'tool_calls':[{'id':name,'function':{'name':'exec_command','arguments':'{"cmd":"python3 -m unittest","yield_time_ms":10000}'}} for name in ('exec','other')]}]
        self.assertEqual(m.prepare_polled_commands(replies,{'exec':16}),['exec'])
        self.assertEqual([json.loads(c['function']['arguments'])['yield_time_ms'] for c in replies[0]['tool_calls']],[1,10000])
if __name__=='__main__':unittest.main()
