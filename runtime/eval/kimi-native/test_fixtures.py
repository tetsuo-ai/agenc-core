import os
import pathlib
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from fixtures import TASKS, prepare, grade, long_prompt
from run import calibrate, ProviderError, cli_command, completion_warning, read_back_observed


class FixturesTest(unittest.TestCase):
    def test_read_back_requires_the_artifact_and_accepts_native_command_tools(self):
        def calls(name, arguments, output='AGENC_DATA\nhi\n[exit 0]\nAGENC_DATA'):
            return [{'tools':[{'id':'read1', 'name':name, 'arguments':arguments}]},
                    {'messages':[{'role':'tool', 'toolCallId':'read1', 'toolOutput':output}]}]
        self.assertTrue(read_back_observed(calls('FileRead', '{"file_path":"hello.txt"}'), 'hello.txt'))
        self.assertFalse(read_back_observed(calls('FileRead', '{"file_path":"unrelated.txt"}'), 'hello.txt'))
        self.assertTrue(read_back_observed(calls('exec_command', '{"cmd":"cat answer.json"}'), 'answer.json'))
        self.assertFalse(read_back_observed(calls('exec_command', '{"cmd":"cat unrelated.txt"}'), 'answer.json'))
        self.assertFalse(read_back_observed(calls('FileRead', '{"file_path":"hello.txt"}', 'File not found'), 'hello.txt'))
        self.assertFalse(read_back_observed(calls('exec_command', '{"cmd":"cat hello.txt"}', 'AGENC_DATA\nno such file\n[exit 1]\nAGENC_DATA'), 'hello.txt'))

    def test_shuffled_context_has_reproducible_independent_answers(self):
        prompt, answer = long_prompt(100, 7)
        self.assertEqual((prompt, answer), long_prompt(100, 7))
        self.assertEqual(len(answer), 24)
        self.assertNotEqual(answer, long_prompt(100, 8)[1])
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            spec = prepare(root, 'long-context', 100, 7)
            import json
            (root/'answer.json').write_text(json.dumps(answer))
            self.assertTrue(grade(root, 'long-context', spec, os.environ)[0])
            (root/'answer.json').write_text(json.dumps(long_prompt(100, 8)[1]))
            self.assertFalse(grade(root, 'long-context', spec, os.environ)[0])

    def test_exact_reply_tasks_do_not_conflict_with_the_prose_completion_gate(self):
        cmd = cli_command('kimi-k3')
        self.assertEqual(cmd[cmd.index('--output-format')+1], 'json')
        self.assertTrue(completion_warning('hi\ncompletion gate exhausted after 3 rounds; the final answer was not verified'))
        self.assertTrue(completion_warning('completion gate settled as partial after 2 rounds'))
        self.assertFalse(completion_warning('{"result":"hi"}'))

    def test_token_calibration_and_funds_refusal_are_distinct(self):
        with patch('run.api', side_effect=[{'data': {'total_tokens': 130000}}, {'data': {'total_tokens': 98000}}]):
            records, estimates = calibrate('any-model', False)
            self.assertEqual(records, 4900)
            self.assertEqual(estimates[-1]['tokens'], 98000)
        refusal = ProviderError(429, {'type':'exceeded_current_quota_error','message':'insufficient balance'})
        with patch('run.api', side_effect=refusal):
            with self.assertRaises(ProviderError):
                calibrate('any-model', False)
            records, estimates = calibrate('any-model', True)
            self.assertEqual(records, 4200)
            self.assertIsNone(estimates[-1]['tokens'])

    def test_unsolved_fixtures_do_not_pass(self):
        with tempfile.TemporaryDirectory() as d:
            for task in TASKS:
                root = pathlib.Path(d)/task
                spec = prepare(root, task)
                self.assertFalse(grade(root, task, spec, os.environ)[0], task)

    def test_debug_first_test_fails_and_real_fix_passes(self):
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            spec = prepare(root, 'debug')
            before = subprocess.run(['node','check.mjs'], cwd=root, capture_output=True, text=True)
            self.assertNotEqual(before.returncode, 0)
            self.assertIn('AssertionError', before.stderr)
            file = root/'sum.mjs'
            file.write_text(file.read_text().replace('<= xs.length','< xs.length'))
            self.assertTrue(grade(root, 'debug', spec, os.environ)[0])
            (root/'check.mjs').write_text('console.log("PASS debug")')
            self.assertFalse(grade(root, 'debug', spec, os.environ)[0])

    def test_multi_file_requires_both_edits(self):
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            spec = prepare(root, 'multi-file')
            file = root/'lib/data.mjs'
            file.write_text(file.read_text().replace('procesData','processData'))
            self.assertFalse(grade(root, 'multi-file', spec, os.environ)[0])
            file = root/'index.mjs'
            file.write_text(file.read_text().replace('procesData','processData'))
            self.assertTrue(grade(root, 'multi-file', spec, os.environ)[0])


if __name__ == '__main__':
    unittest.main()
