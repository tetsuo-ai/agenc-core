"""Run only in an operator-provided --network=none Linux container.

Set LUNA_TEST_CORE to a frozen built CLI. No original harness imports/edits.
The real CLI dispatches the canonical tool; only provider transport is fake.
"""
import datetime
import json
import os
import pathlib
import subprocess
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
SENTINEL = 'LUNA_POLICY_VALIDATION_SENTINEL'


@unittest.skipUnless(os.environ.get('LUNA_TEST_CORE'), 'requires explicit frozen built CLI in network-none container')
class CliRecoveryTests(unittest.TestCase):
    def exercise(self, policy):
        self.assertEqual(os.sys.platform, 'linux', 'built-CLI fixture is Linux-only')
        with tempfile.TemporaryDirectory(prefix='luna-policy-recovery-') as temporary:
            root = pathlib.Path(temporary)
            home = root/'home'
            (home/'agenc').mkdir(parents=True)
            trust = home/'agenc/trusted-projects.json'
            trust.write_text(json.dumps({'version': 1, 'trustedProjects': [{
                'path': str(root), 'trustedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}]}))
            trust.chmod(0o600)
            config = root/'agenc-reasoning.toml'
            config.write_text('config_version = 2\nreasoning_summary = "auto"\n')
            config.chmod(0o600)
            marker = root/'validation-ran.txt'
            # Actual stdlib validation, not a mocked ToolResult or a shell exit.
            # The marker independently proves the canonical tool ran the child.
            (root/'test_policy_failure.py').write_text(
                'import pathlib, unittest\n'
                'class FailingValidation(unittest.TestCase):\n'
                '    def test_validation(self):\n'
                f'        pathlib.Path({str(marker)!r}).write_text({SENTINEL!r})\n'
                f'        self.fail({SENTINEL!r})\n')
            capture = root/'request-settings.jsonl'
            core = pathlib.Path(os.environ['LUNA_TEST_CORE']).resolve()
            # Minimal allowlist, not inherited credential/config/proxy environment.
            env = {key: os.environ[key] for key in ('PATH', 'LANG', 'LC_ALL', 'TZ') if key in os.environ}
            env.update(HOME=str(home), AGENC_HOME=str(home/'agenc'), USER='benchmark', LOGNAME='benchmark',
                       CI='1', OPENAI_API_KEY='synthetic-no-provider-credential',
                       OPENAI_BASE_URL='https://api.openai.com/v1', AGENC_EFFORT_LEVEL='low',
                       AGENC_MAX_OUTPUT_TOKENS='8192', AGENC_LIGHT_REASONING_POLICY=policy,
                       AGENC_OPENAI_REASONING_REPLAY='1', LUNA_POLICY_CAPTURE=str(capture),
                       LUNA_POLICY_MARKER=str(marker), NODE_OPTIONS='--import='+str(HERE/'recovery_fixture.mjs'))
            cli = ['node', str(core/'runtime/bin/agenc')]
            try:
                result = subprocess.run(cli + ['--config', str(config), '--provider', 'openai',
                    '--model', 'gpt-6-luna', '-p', '--output-format', 'json',
                    '--dangerously-bypass-approvals-and-sandbox', '--light',
                    'Run the local validation test once, then report its observed failure.'],
                    cwd=root, env=env, capture_output=True, text=True, timeout=90)
                records = [json.loads(line) for line in capture.read_text().splitlines()] if capture.exists() else []
                # Only safe scalars are exposed on failures, never raw CLI logs.
                self.assertEqual(result.returncode, 0, {'exit_code': result.returncode, 'requests': records})
                self.assertEqual(len(records), 2, records)
                self.assertEqual([row['effort'] for row in records],
                                 ['low', 'medium' if policy == 'adaptive' else 'low'], records)
                self.assertEqual(marker.read_text(), SENTINEL)
                self.assertTrue(records[1]['validation_process_ran'])
                self.assertTrue(records[1]['validation_failure_marker'])
                self.assertTrue(records[1]['tool_exit_one'])
                self.assertEqual(records[1]['matching_tool_results'], 1)
                self.assertTrue('offline recovery validated' in result.stdout, 'synthetic final reply missing')
            finally:
                stopped = subprocess.run(cli+['daemon', 'stop'], cwd=root, env=env,
                                         capture_output=True, text=True, timeout=30)
                self.assertEqual(stopped.returncode, 0, 'task-owned daemon stop failed')

    def test_fixed_low_survives_actual_failed_validation(self):
        self.exercise('fixed')

    def test_explicit_adaptive_control_escalates_after_failed_validation(self):
        self.exercise('adaptive')


if __name__ == '__main__':
    unittest.main()
