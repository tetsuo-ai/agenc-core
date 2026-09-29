#!/usr/bin/env python3
"""Offline Linux configuration, isolation and trace-review checks."""
import contextlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest import mock

if sys.platform!='linux':raise SystemExit('Tests execute only on Linux')
import runner
import trace_audit
import export_evidence
import luna_bridge
from trace_checks import planning_evidence


class PackagingTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='runner-check-',dir=runner.HERE)
        self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
        self.stack=contextlib.ExitStack();self.addCleanup(self.stack.close)
        self.stack.enter_context(mock.patch.object(runner.urllib.request,'urlopen',side_effect=AssertionError('network forbidden')))
        self.stack.enter_context(mock.patch.object(runner.subprocess,'Popen',side_effect=AssertionError('process forbidden')))
        self.stack.enter_context(mock.patch.object(runner.subprocess,'run',side_effect=AssertionError('process forbidden')))
        names=['ROOT','CORE_BASE','CORE_CANDIDATE','PI_PREFIX','TASKS_DIR','PROVIDER','LEDGER','PRICING','PROVENANCE','SPEND_CAP','BALANCE_FLOOR','MAX_CALLS','OPENAI_UPSTREAM','KEY']
        snapshot={name:getattr(runner,name) for name in names}
        self.addCleanup(lambda:[setattr(runner,name,value) for name,value in snapshot.items()])

    def arguments(self):
        for folder in ('base','candidate'):
            cli=self.root/folder/'runtime/bin/agenc';cli.parent.mkdir(parents=True);cli.write_text('fixture')
        pi=self.root/'pi/node_modules/@mariozechner/pi-coding-agent/package.json'
        pi.parent.mkdir(parents=True);pi.write_text(json.dumps({'version':runner.PI_VERSION}))
        binary=self.root/'pi/node_modules/.bin/pi';binary.parent.mkdir();binary.write_text('fixture')
        return runner.parser().parse_args(['--root',str(self.root/'output'),
            '--core-base',str(self.root/'base'),'--core-candidate',str(self.root/'candidate'),
            '--pi-prefix',str(self.root/'pi'),'--phase','candidate-fixture','--tasks','01-chunked-strict'])

    def fake_cmd(self,args,**kwargs):
        value='' if args[:2]==['git','status'] else 'fixture-revision\n' if args[:2]==['git','rev-parse'] else 'v26.5.0\n'
        return SimpleNamespace(returncode=0,stdout=value)

    def test_portable_paths_and_provenance_without_network(self):
        args=self.arguments()
        args.spend_cap_usd=25
        with mock.patch.object(runner,'cmd',side_effect=self.fake_cmd):
            tasks,agents,models=runner.configure(args)
        self.assertEqual(runner.SPEND_CAP,25)
        self.assertEqual(runner.ROOT,self.root/'output');self.assertEqual(runner.CORE_CANDIDATE,self.root/'candidate')
        self.assertEqual(tasks[0]['id'],'01-chunked-strict');self.assertEqual(models,['deepseek-flash'])
        self.assertEqual(agents,['pi','normal','light'])
        self.assertEqual(len(runner.PROVENANCE['configuration_sha256']),64)
        self.assertNotIn(str(self.root),json.dumps(runner.PROVENANCE))

    def test_provider_lock_prevents_same_provider_and_allows_another(self):
        with runner.provider_lock(self.root,'deepseek'):
            with self.assertRaisesRegex(RuntimeError,'Another runner'):
                with runner.provider_lock(self.root,'deepseek'):pass
            with runner.provider_lock(self.root,'openai'):pass
        with runner.provider_lock(self.root,'deepseek'):pass

    def test_repeat_start_schedules_only_the_missing_repeat(self):
        args=self.arguments(); args.repeat_start=2; args.repeats=1; args.agents='light'
        server=mock.Mock(server_port=12345)
        with mock.patch.dict(os.environ,{'DEEPSEEK_API_KEY':'fixture-process-credential'}), \
             mock.patch.object(runner,'parser') as parser, \
             mock.patch.object(runner,'cmd',side_effect=self.fake_cmd), \
             mock.patch.object(runner.http.server,'ThreadingHTTPServer',return_value=server), \
             mock.patch.object(runner,'one') as one:
            parser.return_value.parse_args.return_value=args
            runner.main()
        one.assert_called_once()
        self.assertEqual(one.call_args.args[3],2)
        self.assertEqual(runner.PROVENANCE['repeat_start'],2)
        self.assertEqual(runner.KEY,'')

    def test_credential_removed_before_configuration_subprocesses(self):
        args=SimpleNamespace(phase='baseline',validate_only=True)
        runner.ROOT=self.root;runner.PROVENANCE={'configuration_sha256':'fixture'}
        def configure(_args):
            self.assertNotIn('DEEPSEEK_API_KEY',os.environ)
            self.assertEqual(runner.KEY,'fixture-process-credential')
            return [],[],[]
        with mock.patch.dict(os.environ,{'DEEPSEEK_API_KEY':'fixture-process-credential'}), mock.patch.object(runner,'parser') as parser, mock.patch.object(runner,'configure',side_effect=configure), contextlib.redirect_stdout(io.StringIO()):
            parser.return_value.parse_args.return_value=args
            runner.main()
        self.assertEqual(runner.KEY,'')

    def test_invalid_and_duplicate_selectors_refused(self):
        for raw in ('unknown','pi,pi'):
            with self.assertRaises(ValueError):runner.selection(raw,['pi','normal','light'],'agent')

    def test_limits_and_remote_or_credential_urls_refused(self):
        args=self.arguments()
        for field,value in [('workers',3),('repeats',0),('repeat_start',0),('spend_cap_usd',26),('balance_floor_usd',9),('phase','../escape'),('openai_upstream','https://example.com/v1/responses'),('openai_upstream','http://user:password@localhost/responses')]:
            before=getattr(args,field);setattr(args,field,value)
            with self.assertRaises(ValueError):runner.configure(args)
            setattr(args,field,before)

    def test_pricing_schedule_and_unpriced_model_refusal(self):
        import datetime
        stamp=lambda day,hour:datetime.datetime(2026,9,day,hour,tzinfo=datetime.timezone.utc).timestamp()
        self.assertEqual(runner.rates('deepseek-flash',stamp(29,0)),[.003,.15,.6])
        self.assertEqual(runner.rates('deepseek-flash',stamp(29,1)),[.006,.3,1.2])
        self.assertEqual(runner.rates('deepseek-v4-pro',stamp(27,7)),[.022,.66,1.98])
        with self.assertRaises(KeyError):runner.rates('unpriced',stamp(29,0))

    def test_trace_review_covers_later_calls_without_argument_output(self):
        run=self.root/'runs/fixture';run.mkdir(parents=True);repo=run/'repo';repo.mkdir()
        call=lambda ident,path:{'id':ident,'function':{'name':'FileRead','arguments':json.dumps({'file_path':path})}}
        own=call('own',str(repo/'source.py'));hidden=call('hidden',str(self.root/'tasks/reference.py'))
        for index,items in [(1,[own]),(2,[own,hidden])]:
            (run/f'wire-{index:03}.json').write_text(json.dumps({'body':{'messages':[{'role':'assistant','tool_calls':items}]}}))
        result=trace_audit.audit_run(run,self.root)
        self.assertEqual(result['unique_calls_reviewed'],2);self.assertEqual(result['flagged_calls'],1)
        self.assertNotIn(str(self.root),json.dumps(result))
        self.assertIn('possible_hidden_checker_or_reference',result['findings'][0]['review_reasons'])

    def test_responses_planning_receipts(self):
        run=self.root/'planning';run.mkdir()
        bodies=[{'input':[],'tools':[]},
                {'tools':[{'type':'function','name':'TodoWrite'}], 'input':[
                  {'type':'function_call','call_id':'search','name':'tool2__system_x2esearchTools','arguments':'{}'},
                  {'type':'function_call_output','call_id':'search','output':'{"loaded":["TodoWrite"]}'},
                  {'type':'function_call','call_id':'plan','name':'TodoWrite','arguments':'{}'},
                  {'type':'function_call_output','call_id':'plan','output':'Todos have been modified successfully'}]}]
        for index,body in enumerate(bodies,1):(run/f'wire-{index:03}.json').write_text(json.dumps({'body':body}))
        self.assertTrue(planning_evidence(run,'light')['pass'])

    def test_trace_review_includes_response_only_and_partial_streamed_calls(self):
        run=self.root/'terminal-calls';run.mkdir()
        hidden=str(self.root/'tasks/reference.py')
        events=[{'choices':[{'delta':{'tool_calls':[{'index':0,'id':'chat-call','function':{'name':'FileRead','arguments':'{"file_path":'}}]}}]},
                {'choices':[{'delta':{'tool_calls':[{'index':0,'function':{'arguments':json.dumps(hidden)+'}'}}]}}]}]
        (run/'response-001.txt').write_text(''.join('data: '+json.dumps(e)+'\n\n' for e in events)+'data: [DONE]\n')
        events=[{'type':'response.output_item.added','output_index':0,'item':{'type':'function_call','id':'item','call_id':'responses-call','name':'FileRead','arguments':''}},
                {'type':'response.function_call_arguments.delta','item_id':'item','output_index':0,'delta':'{"file_path":'+json.dumps(hidden)}]
        (run/'response-002.txt').write_text(''.join('data: '+json.dumps(e)+'\n\n' for e in events))
        (run/'response-003.txt').write_text(json.dumps({'output':[{'type':'function_call','id':'full-item','call_id':'full-call','name':'FileRead','arguments':json.dumps({'file_path':hidden})}]}))
        # Replayed calls are deduplicated even if JSON whitespace differs.
        (run/'wire-004.json').write_text(json.dumps({'body':{'messages':[{'tool_calls':[{'id':'chat-call','function':{'name':'FileRead','arguments':json.dumps({'file_path':hidden})}}]}]}}))
        result=trace_audit.audit_run(run,self.root)
        self.assertEqual(result['unique_calls_reviewed'],3);self.assertEqual(result['flagged_calls'],3)
        self.assertEqual(result['malformed_captures'],[])
        self.assertFalse(result['capture_changed_during_audit'])
        self.assertNotIn(hidden,json.dumps(result))
        (run/'response-005.txt').write_text('data: {broken\n')
        self.assertEqual(trace_audit.audit_run(run,self.root)['malformed_captures'],['response-005.txt'])

    def test_evidence_export_keeps_failures_and_strips_private_content(self):
        runs=self.root/'runs';run=runs/'baseline-fixture-pi-r1';run.mkdir(parents=True)
        cancelled=runs/'candidate-fixture-light-r1';cancelled.mkdir()
        (cancelled/'CANCELLED-BEFORE-LAUNCH.json').write_text('{"private_note":"PRIVATE_SENTINEL"}')
        result={'id':run.name,'phase':'baseline','model':'deepseek-flash','pass':False,'check_pass':False,'cost_usd':.5,'private_path':str(self.root)}
        (run/'result.json').write_text(json.dumps(result))
        (run/'wire-001.json').write_text('{"private_content":"PRIVATE_SENTINEL"}')
        ledger=self.root/'spend.jsonl';ledger.write_text(json.dumps({'run':run.name,'cost_usd':.5,'error':{'status':503,'body':'PRIVATE_SENTINEL'}})+'\n'+json.dumps({'run':'legacy-luna','model':'gpt-6-luna','cost_usd':0,'budget_charge_usd':0})+'\n')
        with ledger.open('a') as stream:
            stream.write(json.dumps({'run':run.name,'cost_usd':0,'usage_missing':True,'budget_charge_usd':.2,'original_budget_charge_usd':.4,'budget_charge_basis':'request-time-price-upper-bound'})+'\n')
        out=self.root/'public'
        summary=export_evidence.export(runs,[ledger],['baseline'],out)
        self.assertEqual(summary['selected_runs'],1);self.assertEqual(summary['all_attempts'],2)
        text=''.join(p.read_text() for p in out.iterdir())
        self.assertNotIn('PRIVATE_SENTINEL',text);self.assertNotIn(str(self.root),text)
        selected=json.loads((out/'selected-results.json').read_text())['runs'][0]
        self.assertFalse(selected['pass']);self.assertEqual(selected['cost_usd'],.5)
        self.assertEqual(json.loads((out/'all-call-accounting.json').read_text())['calls'][0]['http_status'],503)
        self.assertEqual(json.loads((out/'all-attempts.json').read_text())['attempts'][1]['status'],'cancelled_before_launch')
        legacy=json.loads((out/'all-call-accounting.json').read_text())['calls'][1]
        self.assertIsNone(legacy['cost_usd']);self.assertEqual(legacy['reported_cost_usd'],0)
        self.assertEqual(legacy['cost_basis'],'subscription-unpriced')
        self.assertEqual(json.loads(ledger.read_text().splitlines()[1])['cost_usd'],0)
        reconciled=json.loads((out/'all-call-accounting.json').read_text())['calls'][2]
        self.assertTrue(reconciled['usage_missing'])
        self.assertEqual(reconciled['original_budget_charge_usd'],.4)
        self.assertEqual(reconciled['budget_charge_usd'],.2)
        self.assertEqual(reconciled['budget_charge_basis'],'request-time-price-upper-bound')

    def test_bridge_has_absolute_duration_and_byte_bounds(self):
        # Fake worker streams, not the HTTP worker. Real calls stay blocked.
        for mode in ('duration','bytes'):
            output=io.BytesIO();frames=luna_bridge.Frames(output)
            if mode=='duration':
                class Process:
                    stdin=io.BytesIO();stdout=io.BytesIO();terminated=False
                    def poll(self):return 0 if self.terminated else None
                    def terminate(self):self.terminated=True
                    def kill(self):self.terminated=True
                    def wait(self,timeout=None):return 0
                process=Process()
                def read_frame(_stream):
                    time.sleep(.03);return None
                manager=mock.patch.object(luna_bridge,'read_frame',side_effect=read_frame)
            else:
                data=io.BytesIO();payload=luna_bridge.Frames(data)
                payload.send(type='response',id='fixture',status=200)
                payload.send(type='chunk',id='fixture',data=luna_bridge.encode(b'x'*20))
                process=SimpleNamespace(stdin=io.BytesIO(),stdout=io.BytesIO(data.getvalue()),poll=lambda:0,terminate=lambda:None,kill=lambda:None,wait=lambda timeout=None:0)
                manager=contextlib.nullcontext()
            with mock.patch.object(luna_bridge.subprocess,'Popen',return_value=process),manager:
                luna_bridge.bounded_forward({'v':1,'id':'fixture','method':'POST','path':'/v1/responses','body':''},frames,'fixture-bearer',max_seconds=.01 if mode=='duration' else 1,max_response_bytes=10)
            wire=output.getvalue().decode()
            decoded=wire+''.join(luna_bridge.decode(item['data']).decode() for item in map(json.loads,wire.splitlines()) if item.get('type')=='chunk')
            self.assertIn('request_duration_limit' if mode=='duration' else 'response_byte_limit',decoded)
            self.assertNotIn('fixture-bearer',wire)


if __name__=='__main__':unittest.main()
