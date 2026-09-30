#!/usr/bin/env python3
"""Linux-only synthetic runner checks. Every process and provider call is mocked."""
from __future__ import annotations
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest import mock
import urllib.error

if sys.platform != 'linux':
    raise SystemExit('Runner verification executes only on Linux')

HERE=Path(__file__).resolve().parent
with mock.patch.dict(os.environ, {'DEEPSEEK_API_KEY':'fixture-only-not-a-provider-key'}, clear=True):
    spec=importlib.util.spec_from_file_location('light_runner_under_test',HERE/'runner.py')
    runner=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runner)


class FakeResponse:
    status=200
    headers={'Content-Type':'text/event-stream'}
    def __init__(self,events):
        self.lines=[b'data: '+json.dumps(event).encode()+b'\n\n' for event in events]
    def __enter__(self): return self
    def __exit__(self,*args): return False
    def __iter__(self): return iter(self.lines)


class FakeHandler:
    def __init__(self,rid,body):
        data=json.dumps(body).encode()
        self.path=f'/{rid}/v1/responses'
        self.headers={'Content-Length':str(len(data))}
        self.rfile=io.BytesIO(data)
        self.wfile=io.BytesIO()
        self.statuses=[]
    def send_response(self,status): self.statuses.append(status)
    def send_header(self,*args): pass
    def end_headers(self): pass
    def send_error(self,status,*args): self.statuses.append(status)


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='runner-check-',dir=HERE)
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.stack=contextlib.ExitStack(); self.addCleanup(self.stack.close)
        self.stack.enter_context(mock.patch.dict(os.environ,{'PATH':'/usr/bin:/bin'},clear=True))
        self.stack.enter_context(mock.patch.multiple(runner,ROOT=self.root,LEDGER=self.root/'spend.jsonl',
                    ACTIVE={},PROVIDER='deepseek',KEY='fixture-only-not-a-provider-key',
                    RATE_LIMITED=threading.Event(),LOCK=threading.Lock()))
        # Any accidental network/process call fails the test instead of spending money.
        self.network=self.stack.enter_context(mock.patch.object(runner.urllib.request,'urlopen',side_effect=AssertionError('network forbidden')))
        self.process=self.stack.enter_context(mock.patch.object(runner.subprocess,'Popen',side_effect=AssertionError('process forbidden')))
        self.shell=self.stack.enter_context(mock.patch.object(runner.subprocess,'run',side_effect=AssertionError('subprocess forbidden')))
        self.kill=self.stack.enter_context(mock.patch.object(runner.os,'killpg'))
        self.task={'id':'fixture','repo_url':'https://invalid.example/fixture','repo_sha':'fixture-source',
                   'setup_script':'fixture/setup.py','check_script':'fixture/check.py','prompt':'Fixture task.','timeout_seconds':1}
        (self.root/'repos/fixture-source').mkdir(parents=True)
        self.stack.enter_context(mock.patch.object(runner,'balance',return_value={'is_available':True,'total_balance':'100'}))
        self.revision='fixture-revision'
        self.check_code=0
        self.cmd=self.stack.enter_context(mock.patch.object(runner,'cmd',side_effect=self.fake_cmd))
        self.stack.enter_context(contextlib.redirect_stdout(io.StringIO()))

    def fake_cmd(self,args,**kwargs):
        if args[:3]==['git','rev-parse','HEAD']:
            return SimpleNamespace(returncode=0,stdout=self.revision+'\n')
        if args[:2]==['git','clone']:
            Path(args[-1]).mkdir(parents=True,exist_ok=True)
        if len(args)>1 and str(args[1]).endswith('/check.py'):
            return SimpleNamespace(returncode=self.check_code,stdout='fixture check\n')
        return SimpleNamespace(returncode=0,stdout='fixture command\n')

    def agent(self,*,timeout=False,exit_code=0,budget_stop=False,error=None,usage_missing=False):
        outer=self
        class Process:
            pid=987654321
            waits=0
            def wait(self,timeout=None):
                self.waits+=1
                if timeout_mode and self.waits==1:
                    raise subprocess.TimeoutExpired('fixture-agent',timeout)
                return exit_code
        timeout_mode=timeout
        def factory(*args,**kwargs):
            state=next(iter(runner.ACTIVE.values()))
            state['calls']=1
            state['records']=[{'input_tokens':20,'cached_tokens':5,'uncached_tokens':15,'output_tokens':10,
                               'tool_calls':1,'cost_usd':.001,'budget_charge_usd':.001,
                               'usage_missing':usage_missing,'error':error}]
            if budget_stop:state.update(budget_stop=True,stop_reason='call_limit')
            return Process()
        self.process.side_effect=factory
        return runner.one(self.task,'light','deepseek-flash',1,'candidate-fixture',12345)

    def test_success_keeps_token_and_cost_accounting(self):
        result=self.agent()
        self.assertTrue(result['pass']); self.assertTrue(result['check_pass']); self.assertTrue(result['usage_complete'])
        self.assertEqual((result['input_tokens'],result['cached_tokens'],result['uncached_tokens'],result['output_tokens']),(20,5,15,10))
        self.assertEqual(result['cost_usd'],.001)
        self.network.assert_not_called()

    def test_timeout_with_zero_exit_and_passing_code_is_not_task_pass(self):
        result=self.agent(timeout=True)
        self.assertFalse(result['pass']); self.assertTrue(result['check_pass']); self.assertTrue(result['timeout'])
        self.assertEqual(result['exit_code'],0)
        self.kill.assert_called_once_with(987654321,signal.SIGTERM)

    def test_budget_stop_preserves_code_quality_and_denies_task_pass(self):
        result=self.agent(budget_stop=True)
        self.assertFalse(result['pass']); self.assertTrue(result['check_pass'])
        self.assertTrue(result['budget_stop']); self.assertEqual(result['stop_reason'],'call_limit')

    def test_nonzero_exit_is_not_task_pass_even_with_passing_code(self):
        result=self.agent(exit_code=1)
        self.assertFalse(result['pass']); self.assertTrue(result['check_pass'])

    def test_failed_code_is_retained_even_with_successful_process(self):
        self.check_code=1
        result=self.agent()
        self.assertFalse(result['pass']); self.assertFalse(result['check_pass']); self.assertEqual(result['input_tokens'],20)

    def test_provider_and_usage_problems_remain_separate_from_artifact_check(self):
        result=self.agent(error={'status':503},usage_missing=True)
        self.assertTrue(result['check_pass']); self.assertEqual(result['provider_errors'],1); self.assertFalse(result['usage_complete'])
        self.assertEqual(result['input_tokens'],20)

    def test_completed_result_reuse_requires_prompt_identity(self):
        result=self.agent()
        self.task['prompt']='Changed task.'
        with self.assertRaisesRegex(RuntimeError,'identity differs'):
            runner.one(self.task,'light','deepseek-flash',1,'candidate-fixture',12345)
        self.assertEqual(json.loads((runner.ROOT/'runs'/result['id']/'result.json').read_text())['prompt_sha256'],result['prompt_sha256'])

    def test_completed_result_reuse_requires_revision_identity(self):
        self.agent(); self.revision='different-revision'
        with self.assertRaisesRegex(RuntimeError,'identity differs'):
            runner.one(self.task,'light','deepseek-flash',1,'candidate-fixture',12345)

    def test_incomplete_attempt_is_not_deleted(self):
        directory=self.root/'runs/candidate-fixture-deepseek-flash-fixture-light-r1'
        directory.mkdir(parents=True); marker=directory/'evidence.txt'; marker.write_text('preserve me')
        with self.assertRaisesRegex(RuntimeError,'Incomplete attempt preserved'):
            runner.one(self.task,'light','deepseek-flash',1,'candidate-fixture',12345)
        self.assertEqual(marker.read_text(),'preserve me'); self.process.assert_not_called()

    def proxy(self,events,provider='openai',calls=0,http_error=None,disconnect=False):
        runner.PROVIDER=provider
        rid='wire-fixture'; directory=self.root/rid; directory.mkdir()
        state={'dir':directory,'calls':calls,'records':[]}; runner.ACTIVE[rid]=state
        body={'model':'gpt-6-luna' if provider=='openai' else 'deepseek-flash','stream':True,'max_tokens':8192}
        handler=FakeHandler(rid,body)
        if disconnect:
            handler.wfile=mock.Mock()
            handler.wfile.write.side_effect=ConnectionResetError('fixture downstream disconnect')
        if http_error is None:self.network.side_effect=None;self.network.return_value=FakeResponse(events)
        else:self.network.side_effect=http_error
        runner.Proxy.forward(handler)
        return state,handler

    def test_responses_usage_and_tool_calls_are_accounted_once(self):
        usage={'input_tokens':100,'input_tokens_details':{'cached_tokens':40},'output_tokens':20}
        events=[{'type':'response.output_item.added','item':{'type':'function_call','id':'item-a','call_id':'call-a'}},
                {'type':'response.output_item.done','item':{'type':'function_call','id':'item-a','call_id':'call-a'}},
                {'type':'response.completed','response':{'usage':usage}}]
        state,_=self.proxy(events); record=state['records'][0]
        self.assertEqual((record['input_tokens'],record['cached_tokens'],record['uncached_tokens'],record['output_tokens']),(100,40,60,20))
        self.assertEqual(record['tool_calls'],1);self.assertFalse(record['usage_missing']);self.assertIsNone(record['error'])

    def test_chat_usage_and_streamed_tool_id_are_accounted_once(self):
        events=[{'choices':[{'delta':{'tool_calls':[{'index':0,'id':'call-a'}]}}]},
                {'choices':[{'delta':{'tool_calls':[{'index':0,'function':{'arguments':'{}'}}]}}]},
                {'usage':{'prompt_tokens':100,'prompt_cache_hit_tokens':40,'prompt_cache_miss_tokens':60,'completion_tokens':20}}]
        state,_=self.proxy(events,provider='deepseek');record=state['records'][0]
        self.assertEqual(record['tool_calls'],1);self.assertEqual(record['input_tokens'],100);self.assertGreater(record['cost_usd'],0)

    def test_sse_error_is_provider_error_with_unknown_usage(self):
        state,_=self.proxy([{'type':'error','code':'rate_limit_exceeded'}]);record=state['records'][0]
        self.assertEqual(record['error']['event_type'],'error');self.assertTrue(record['usage_missing']);self.assertTrue(runner.RATE_LIMITED.is_set())

    def test_sse_failed_is_classified(self):
        state,_=self.proxy([{'type':'response.failed','response':{'error':{'code':'server_error'}}}]);record=state['records'][0]
        self.assertEqual(record['error']['event_type'],'response.failed');self.assertTrue(record['usage_missing'])

    def test_incomplete_terminal_response_preserves_reported_billable_usage(self):
        usage={'input_tokens':42,'input_tokens_details':{'cached_tokens':12},'output_tokens':7}
        state,_=self.proxy([{'type':'response.incomplete','response':{'usage':usage,'incomplete_details':{'reason':'max_output_tokens'}}}])
        record=state['records'][0]
        self.assertEqual(record['error']['event_type'],'response.incomplete')
        self.assertEqual((record['input_tokens'],record['cached_tokens'],record['output_tokens']),(42,12,7))
        self.assertFalse(record['usage_missing'])

    def test_downstream_connection_reset_still_drains_upstream_usage(self):
        events=[{'choices':[{'delta':{'content':'fixture'}}]},
                {'usage':{'prompt_tokens':100,'prompt_cache_hit_tokens':40,'prompt_cache_miss_tokens':60,'completion_tokens':20}}]
        state,handler=self.proxy(events,provider='deepseek',disconnect=True)
        record=state['records'][0]
        self.assertIsNone(record['error']);self.assertFalse(record['usage_missing'])
        self.assertEqual((record['input_tokens'],record['output_tokens']),(100,20))
        self.assertIn(b'prompt_tokens',(state['dir']/'response-001.txt').read_bytes())
        self.assertEqual(handler.wfile.write.call_count,2)

    def test_local_call_cap_is_recorded_without_contacting_provider(self):
        state,handler=self.proxy([],calls=45)
        self.assertTrue(state['budget_stop']);self.assertEqual(state['stop_reason'],'call_limit');self.assertEqual(handler.statuses,[429])
        self.network.assert_not_called()

    def test_http_429_stops_subset_and_remains_visible(self):
        error=urllib.error.HTTPError('http://fixture.invalid',429,'fixture limit',{},io.BytesIO(b'{"error":"fixture"}'))
        state,_=self.proxy([],http_error=error);record=state['records'][0]
        self.assertEqual(record['error']['status'],429);self.assertFalse(record['usage_missing']);self.assertTrue(runner.RATE_LIMITED.is_set())


if __name__=='__main__':
    unittest.main(verbosity=2)
