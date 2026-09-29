import importlib.util
import json
import pathlib
import unittest
import tempfile
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('replay',pathlib.Path(__file__).with_name('replay.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class ReplayTests(unittest.TestCase):
    def test_cache_revision_validation_precedes_path_resolution(self):
        invalid = ('', '../outside', '/tmp/cache', 'a/b', '--help', 'a'*39,
                   'a'*41, 'g'*40, 'A'*40, 'a'*40+'\n', None, 42, ['a'*40])
        for value in invalid:
            with self.subTest(value=value), patch.object(m, 'confined_path') as resolve:
                with self.assertRaises(ValueError):m.repository_cache_path('/cache', value)
                resolve.assert_not_called()
    def test_cache_revision_retains_resolved_containment(self):
        revision='a'*40
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory)/'root';root.mkdir()
            self.assertEqual(m.repository_cache_path(root,revision),root.resolve()/revision)
            (root/revision).symlink_to(pathlib.Path(directory))
            with self.assertRaises(ValueError):m.repository_cache_path(root,revision)
    def test_confined_paths_reject_absolute_traversal_and_symlink_escape(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory)/'root';root.mkdir()
            (root/'escape').symlink_to(pathlib.Path(directory))
            for value in ('../outside', '/tmp/outside', 'escape/outside', '.'):
                with self.subTest(value=value), self.assertRaises(ValueError):
                    m.confined_path(root,value)
            self.assertEqual(m.confined_path(root,'setup/task.py'),root.resolve()/'setup/task.py')
    def test_command_rejects_interpreter_flags_and_unapproved_executables(self):
        for args in (['sh','/tmp/script'], ['python3','-c','print(1)'], ['node','--eval','x'], 'node /tmp/script'):
            with self.subTest(args=args), patch.object(m.subprocess,'run') as run:
                with self.assertRaises(ValueError):m.command(args)
                run.assert_not_called()
    def test_command_keeps_script_arguments_literal_without_a_shell(self):
        with patch.object(m.subprocess,'run') as run:
            run.return_value.returncode=0
            args=['node','/work/core/runtime/bin/agenc','literal; $(not-executed)']
            self.assertEqual(m.command(args),0)
            self.assertEqual(run.call_args.args[0],args)
            self.assertIs(run.call_args.kwargs['shell'],False)
    def test_prompt_starting_with_an_option_is_stdin_data(self):
        with patch.object(m.subprocess,'run') as run:
            run.return_value.returncode=0
            args=['node','/work/core/runtime/bin/agenc','-p']
            prompt='--some-option\nLiteral prompt with $() and quotes'
            self.assertEqual(m.command(args,stdin_text=prompt),0)
            self.assertEqual(run.call_args.args[0],args)
            self.assertEqual(run.call_args.kwargs['input'],prompt)
            self.assertTrue(run.call_args.kwargs['text'])
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
