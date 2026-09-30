"""Zero-API Luna runner settings tests. Run with Python 3.11+ for tomllib."""
import contextlib
import copy
import io
import json
import pathlib
import tempfile
import tomllib
import types
import unittest
from unittest import mock

import runner


class RunnerSettingsTests(unittest.TestCase):
    def setUp(self):
        self.stack=contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.root=pathlib.Path(self.stack.enter_context(tempfile.TemporaryDirectory(prefix='luna settings ')))
        self.run_root=self.root/'results'
        self.run_root.mkdir()
        self.core=self.root/'core checkout'
        (self.core/'runtime/bin').mkdir(parents=True)
        (self.core/'runtime/bin/agenc').write_text('synthetic CLI fixture')
        self.pi=self.root/'pi'
        (self.pi/'node_modules/.bin').mkdir(parents=True)
        (self.pi/'node_modules/.bin/pi').write_text('synthetic Pi fixture')
        package=self.pi/'node_modules/@mariozechner/pi-coding-agent/package.json'
        package.parent.mkdir(parents=True)
        package.write_text(json.dumps({'version':runner.PI_VERSION}))
        self.tasks=self.root/'tasks'
        self.tasks.mkdir()
        for name in ('setup.py','check.py'):
            (self.tasks/name).write_text('# synthetic fixture; never executed\n')
        self.task={'id':'fixture','prompt':'Do work; literal --config text stays in prompt.',
                   'repo_sha':'b'*40,'repo_url':'unused','setup_script':'setup.py',
                   'check_script':'check.py','timeout_seconds':300}
        (self.tasks/'manifest.json').write_text(json.dumps({'tasks':[self.task]}))
        (self.run_root/'repos'/self.task['repo_sha']).mkdir(parents=True)
        names=('ROOT','CORE_BASE','CORE_CANDIDATE','PI_PREFIX','TASKS_DIR','PROVIDER','LEDGER',
               'PRICING','PROVENANCE','SPEND_CAP','BALANCE_FLOOR','MAX_CALLS','OPENAI_UPSTREAM',
               'OPENAI_REASONING_REPLAY','UPSTREAM','ADAPTIVE_EFFORT','ADAPTIVE_HIGH',
               'REASONING_SUMMARY','ACTIVE','KEY')
        self.stack.enter_context(mock.patch.multiple(runner,**{name:getattr(runner,name) for name in names}))
        runner.ROOT=self.run_root
        runner.CORE_BASE=runner.CORE_CANDIDATE=self.core
        runner.PI_PREFIX=self.pi
        runner.TASKS_DIR=self.tasks
        runner.PROVIDER='openai'
        runner.PROVENANCE={'configuration_sha256':'fixture-identity'}
        runner.REASONING_SUMMARY='auto'
        runner.ADAPTIVE_EFFORT=runner.ADAPTIVE_HIGH=False
        runner.OPENAI_REASONING_REPLAY=False
        runner.ACTIVE={}
        runner.KEY='synthetic-test-secret'
        self.stack.enter_context(mock.patch.object(runner.sys,'platform','linux'))
        self.stack.enter_context(mock.patch.object(runner.urllib.request,'urlopen',side_effect=AssertionError('No network permitted in settings tests')))
        self.stack.enter_context(mock.patch.object(runner.shutil,'disk_usage',return_value=types.SimpleNamespace(free=20*1024**3)))
        self.stack.enter_context(mock.patch.object(runner.os,'getloadavg',return_value=(0,0,0)))
        self.commands=[]
        def fake_cmd(args,**kwargs):
            self.commands.append((args,kwargs))
            stdout='a'*40 if args[:3]==['git','rev-parse','HEAD'] else 'v26.8.1' if args==['node','--version'] else ''
            return types.SimpleNamespace(returncode=0,stdout=stdout)
        self.stack.enter_context(mock.patch.object(runner,'cmd',side_effect=fake_cmd))
        self.launches=[]
        def fake_popen(args,**kwargs):
            self.launches.append((args,kwargs))
            return types.SimpleNamespace(wait=lambda **_kwargs:0,pid=12345)
        self.stack.enter_context(mock.patch.object(runner.subprocess,'Popen',side_effect=fake_popen))

    def args(self,*extra):
        return runner.parser().parse_args([
            '--root',str(self.run_root),'--core-base',str(self.core),
            '--core-candidate',str(self.core),'--pi-prefix',str(self.pi),
            '--tasks-manifest',str(self.tasks/'manifest.json'),
            '--phase','candidate-settings-fixture',*extra])

    def execute(self,agent='light',phase='candidate-settings-fixture'):
        with contextlib.redirect_stdout(io.StringIO()):
            return runner.one(self.task,agent,'gpt-6-luna',1,phase,None)

    def test_cli_summary_default_and_choices(self):
        self.assertEqual(self.args().reasoning_summary,'auto')
        for choice in runner.REASONING_SUMMARIES:
            self.assertEqual(self.args('--reasoning-summary',choice).reasoning_summary,choice)
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            self.args('--reasoning-summary','auto\nmalicious=true')

    def test_toml_values_parse_and_existing_files_are_never_overwritten(self):
        for choice in runner.REASONING_SUMMARIES:
            directory=self.root/choice
            directory.mkdir()
            path=runner.write_reasoning_config(directory,choice)
            self.assertEqual(tomllib.loads(path.read_text()),{'config_version':2,'reasoning_summary':choice})
            self.assertEqual(path.stat().st_mode & 0o777,0o600)
            original=path.read_bytes()
            with self.assertRaises(FileExistsError):
                runner.write_reasoning_config(directory,'auto')
            self.assertEqual(path.read_bytes(),original)

    def test_toml_injection_rejected_before_file_write(self):
        for value in ('auto"\n[permissions]\nmode="bypass"','',None):
            with self.assertRaises(ValueError):
                runner.write_reasoning_config(self.root,value)
        self.assertFalse((self.root/'agenc-reasoning.toml').exists())

    def test_non_pi_launch_passes_explicit_config_before_positional_prompt(self):
        runner.REASONING_SUMMARY='detailed'
        self.execute()
        args,kwargs=self.launches[0]
        index=args.index('--config')
        config=pathlib.Path(args[index+1])
        self.assertTrue(config.is_absolute())
        self.assertIn(' ',str(config))
        self.assertEqual(tomllib.loads(config.read_text()),{'config_version':2,'reasoning_summary':'detailed'})
        self.assertLess(index,args.index('-p'))
        self.assertEqual(args[-1],self.task['prompt'])
        self.assertEqual(args.count('--config'),1)
        self.assertIn('--light',args)
        self.assertEqual(kwargs['cwd'].name,'repo')
        env=kwargs['env']
        self.assertEqual(env['AGENC_EFFORT_LEVEL'],'low')
        self.assertEqual(env['AGENC_LIGHT_REASONING_POLICY'],'fixed')
        self.assertEqual(env['LUNA_ALLOW_ADAPTIVE'],'0')
        self.assertEqual(env['LUNA_ADAPTIVE_HIGH'],'0')
        self.assertEqual(env['OPENAI_BASE_URL'],'https://api.openai.com/v1')
        self.assertEqual(env['NODE_OPTIONS'],'--import='+str(runner.HERE/'direct.mjs'))
        self.assertEqual(env['LUNA_TASK_CALL_CAP'],'45')
        self.assertNotIn('synthetic-test-secret',config.read_text())

    def test_explicit_policy_overrides_inherited_adaptive_environment(self):
        with mock.patch.dict(runner.os.environ,{'AGENC_LIGHT_REASONING_POLICY':'adaptive'}):
            self.execute()
        self.assertEqual(self.launches[0][1]['env']['AGENC_LIGHT_REASONING_POLICY'],'fixed')

    def test_adaptive_flag_forwards_policy_only_to_light(self):
        runner.ADAPTIVE_EFFORT=True
        runner.ADAPTIVE_HIGH=True
        for agent in ('light','normal','pi'):
            self.execute(agent)
            args,kwargs=self.launches[-1]
            env=kwargs['env']
            expected=agent=='light'
            self.assertEqual(env['AGENC_LIGHT_REASONING_POLICY'],'adaptive' if expected else 'fixed')
            self.assertEqual(env['LUNA_ALLOW_ADAPTIVE'],'1' if expected else '0')
            self.assertEqual(env['LUNA_ADAPTIVE_HIGH'],'1' if expected else '0')
            self.assertEqual(env['AGENC_EFFORT_LEVEL'],'low')
            if agent=='pi':
                self.assertNotIn('--config',args)
                self.assertFalse((pathlib.Path(env['LUNA_RUN_DIR'])/'agenc-reasoning.toml').exists())

    def test_normal_arm_gets_explicit_summary_without_light_flag(self):
        runner.REASONING_SUMMARY='none'
        self.execute('normal')
        args,_=self.launches[0]
        self.assertNotIn('--light',args)
        path=pathlib.Path(args[args.index('--config')+1])
        self.assertEqual(tomllib.loads(path.read_text()),{'config_version':2,'reasoning_summary':'none'})

    def test_pi_nonauto_rejected_before_subprocesses_or_artifacts(self):
        runner.REASONING_SUMMARY='concise'
        with self.assertRaisesRegex(ValueError,'Pi uses'):
            self.execute('pi')
        self.assertFalse(self.launches)
        self.assertFalse(self.commands)
        self.assertFalse((self.run_root/'runs').exists())

    def test_configure_rejects_nonauto_pi_before_metadata_subprocesses(self):
        with self.assertRaisesRegex(ValueError,'Pi uses'):
            runner.configure(self.args('--reasoning-summary','none'))
        self.assertFalse(self.commands)
        self.assertFalse(self.launches)

    def test_provenance_declares_per_arm_settings_and_hash_changes(self):
        runner.configure(self.args())
        original=copy.deepcopy(runner.PROVENANCE)
        self.assertEqual(original['reasoning_summary'],'auto')
        self.assertEqual(original['reasoning_settings_by_agent']['pi'],
                         {'reasoning_effort':'low','reasoning_summary':'auto','light_reasoning_policy':'fixed'})
        self.assertEqual(original['reasoning_settings_by_agent']['light']['light_reasoning_policy'],'fixed')
        runner.configure(self.args('--adaptive-effort'))
        changed=runner.PROVENANCE
        self.assertEqual(changed['reasoning_settings_by_agent']['light']['light_reasoning_policy'],'adaptive')
        self.assertEqual(changed['reasoning_settings_by_agent']['pi']['light_reasoning_policy'],'fixed')
        self.assertNotEqual(original['configuration_sha256'],changed['configuration_sha256'])
        # configure computes new metadata in memory; it writes no phase file.
        self.assertFalse(list(self.run_root.glob('provenance-*')))
        runner.configure(self.args('--agents','light','--reasoning-summary','concise'))
        self.assertEqual(runner.PROVENANCE['reasoning_settings_by_agent']['light']['reasoning_summary'],'concise')

    def test_retained_result_and_config_not_rewritten_or_relaunched(self):
        first=self.execute()
        path=self.run_root/'runs'/first['id']
        before={item.name:item.read_bytes() for item in path.iterdir() if item.is_file()}
        second=self.execute()
        self.assertEqual(second,json.loads(json.dumps(first)))
        self.assertEqual(len(self.launches),1)
        self.assertEqual({item.name:item.read_bytes() for item in path.iterdir() if item.is_file()},before)
        runner.PROVENANCE={'configuration_sha256':'new-settings'}
        with self.assertRaisesRegex(RuntimeError,'new phase'):
            self.execute()
        self.assertEqual({item.name:item.read_bytes() for item in path.iterdir() if item.is_file()},before)

    def test_historical_provenance_file_is_not_touched_by_configure(self):
        retained=self.run_root/'provenance-historical-openai.json'
        retained.write_bytes(b'{"historical":"keep exact bytes"}\n')
        before=retained.read_bytes()
        runner.configure(self.args('--agents','light','--reasoning-summary','detailed'))
        self.assertEqual(retained.read_bytes(),before)
        self.assertFalse(self.launches)

    def test_phase_provenance_reuse_preserves_bytes_and_rejects_changed_settings(self):
        retained=self.run_root/'provenance-candidate-old-openai.json'
        original={'reasoning_summary':'auto','configuration_sha256':'old'}
        runner.write_phase_provenance(retained,original)
        # Equal JSON with different formatting must not get normalized/replaced.
        retained.write_text(json.dumps(original,separators=(',',':')))
        before=retained.read_bytes()
        runner.write_phase_provenance(retained,original)
        self.assertEqual(retained.read_bytes(),before)
        with self.assertRaisesRegex(RuntimeError,'new phase'):
            runner.write_phase_provenance(retained,dict(original,reasoning_summary='none'))
        self.assertEqual(retained.read_bytes(),before)

    def test_validate_only_main_cannot_overwrite_historical_phase(self):
        args=self.args('--validate-only')
        retained=self.run_root/f'provenance-{args.phase}-openai.json'
        retained.write_text('{"historical":"preserve"}\n')
        before=retained.read_bytes()
        with mock.patch.object(runner,'parser',return_value=types.SimpleNamespace(parse_args=lambda:args)), \
             mock.patch.dict(runner.os.environ,{'OPENAI_API_KEY':'synthetic-process-key'}), \
             self.assertRaisesRegex(RuntimeError,'new phase'):
            runner.main()
        self.assertEqual(retained.read_bytes(),before)
        self.assertFalse(self.launches)


if __name__=='__main__':
    unittest.main()
