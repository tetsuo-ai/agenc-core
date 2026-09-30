"""Real built CLI + synthetic Responses fixture; run in --network=none container.

No provider credentials. Set LUNA_TEST_CORE to the frozen build directory.
This catches config-loader/startup contracts that mocked runner tests cannot.
"""
import json
import datetime
import os
import pathlib
import subprocess
import tempfile
import unittest

import runner


@unittest.skipUnless(os.environ.get('LUNA_TEST_CORE'), 'requires explicit frozen built CLI')
class BuiltCliStartupTests(unittest.TestCase):
    def exercise(self, legacy=False, summary='auto'):
        with tempfile.TemporaryDirectory(prefix='luna-startup-') as temp:
            root = pathlib.Path(temp)
            home = root / 'home'
            home.mkdir()
            (home / 'agenc').mkdir()
            trust = home / 'agenc/trusted-projects.json'
            trust.write_text(json.dumps({'version': 1, 'trustedProjects': [
                {'path': str(root), 'trustedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}]}))
            trust.chmod(0o600)
            config = runner.write_reasoning_config(root, summary)
            if legacy:
                config.write_text('reasoning_summary = "auto"\n')
            capture = root / 'capture.jsonl'
            core = pathlib.Path(os.environ['LUNA_TEST_CORE'])
            env = {key: value for key, value in os.environ.items()
                   if not any(word in key for word in ('KEY', 'TOKEN', 'SECRET'))
                   and not key.startswith(('AGENC_', 'OPENAI_', 'DEEPSEEK_', 'LUNA_', 'NODE_OPTIONS'))}
            env.update(HOME=str(home), AGENC_HOME=str(home / 'agenc'), CI='1',
                       USER='benchmark', LOGNAME='benchmark',
                       OPENAI_API_KEY='synthetic-no-provider-credential',
                       OPENAI_BASE_URL='https://api.openai.com/v1',
                       AGENC_EFFORT_LEVEL='low', AGENC_MAX_OUTPUT_TOKENS='8192',
                       AGENC_LIGHT_REASONING_POLICY='fixed', AGENC_OPENAI_REASONING_REPLAY='1',
                       LUNA_STARTUP_CAPTURE=str(capture),
                       LUNA_STARTUP_SUMMARY=summary,
                       NODE_OPTIONS='--import=' + str(pathlib.Path(__file__).with_name('startup_fixture.mjs')))
            cli = ['node', str(core / 'runtime/bin/agenc')]
            try:
                result = subprocess.run(cli + ['--config', str(config), '--provider', 'openai',
                    '--model', 'gpt-6-luna', '-p', '--output-format', 'json',
                    '--dangerously-bypass-approvals-and-sandbox', '--light', 'Reply startup validated; use no tools.'],
                    cwd=root, env=env, capture_output=True, text=True, timeout=60)
                records = [json.loads(line) for line in capture.read_text().splitlines()] if capture.exists() else []
                if legacy:
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn('must declare config_version = 2', result.stdout + result.stderr)
                    self.assertEqual(records, [])
                else:
                    self.assertEqual(result.returncode, 0, (result.stdout + result.stderr)[-3000:])
                    self.assertEqual(len(records), 1)
                    self.assertEqual(records[0], {'model': 'gpt-6-luna', 'effort': 'low', 'summary': summary,
                        'output_cap': 8192, 'include': ['reasoning.encrypted_content']})
                    self.assertIn('startup validated', result.stdout)
            finally:
                subprocess.run(cli + ['daemon', 'stop'], cwd=root, env=env,
                               capture_output=True, text=True, timeout=30)

    def test_generated_v2_config_reaches_verified_synthetic_response(self):
        self.exercise()

    def test_versionless_config_fails_before_any_request(self):
        self.exercise(legacy=True)

    def test_nondefault_summary_proves_config_value_reaches_wire(self):
        self.exercise(summary='concise')


if __name__ == '__main__':
    unittest.main()
