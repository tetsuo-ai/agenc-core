from pathlib import Path
root=Path('/private/tmp/light-ultra/benchmark/runtime/benchmarks/light-mode')
p=root/'runner.py';s=p.read_text().replace("ap.add_argument('--repeats',type=int,default=2)","ap.add_argument('--repeats',type=int,default=2)\n    ap.add_argument('--repeat-start',type=int,default=1,help='First repeat ID; resume missing cells without repeating completed attempts')")
s=s.replace('args.repeats<1 or args.max_calls<1','args.repeats<1 or args.repeat_start<1 or args.max_calls<1').replace('repeats >=1 and max-calls >=1','repeats/repeat-start >=1 and max-calls >=1')
s=s.replace("'repeats':args.repeats,'workers'", "'repeats':args.repeats,'repeat_start':args.repeat_start,'workers'")
s=s.replace('range(1,args.repeats+1)', 'range(args.repeat_start,args.repeat_start+args.repeats)')
p.write_text(s)
p=root/'summarize.py';s=p.read_text().replace('required_runs, confirmatory=False):','required_runs, confirmatory=False, reuse_candidate_phases=()):')
needle="    runs, malformed, orphans = read_runs(root)"
s=s.replace(needle,"    candidate_phases = [candidate_phase, *reuse_candidate_phases]\n    if len(candidate_phases) != len(set(candidate_phases)): raise ValueError('Duplicate candidate phases')\n    if reuse_candidate_phases and (confirmatory or baseline_phase in candidate_phases): raise ValueError('Reused candidate phases must be separate from baseline')\n"+needle)
s=s.replace("                    phase = candidate_phase if agent == 'light' else baseline_phase\n                    prefix = f'{phase}-{model}-{task}-{agent}-r'\n                    if not name.startswith(prefix) or not name[len(prefix):].isdigit(): continue\n                    runs.append({'id':name,'phase':phase,'model':model,'task':task,'agent':agent,\n                                 'repeat':int(name[len(prefix):]),'pass':False,'usage_complete':False,\n                                 '_unfinished':True,'_malformed':name in malformed_dirs,\n                                 '_path':str(root/name/'result.json'),'_dir_name':name,\n                                 '_anatomy':anatomy(root/name),'_sampling':sampling({})})", "                    for phase in candidate_phases if agent == 'light' else [baseline_phase]:\n                        prefix = f'{phase}-{model}-{task}-{agent}-r'\n                        if not name.startswith(prefix) or not name[len(prefix):].isdigit(): continue\n                        runs.append({'id':name,'phase':phase,'model':model,'task':task,'agent':agent,\n                                     'repeat':int(name[len(prefix):]),'pass':False,'usage_complete':False,\n                                     '_unfinished':True,'_malformed':name in malformed_dirs,\n                                     '_path':str(root/name/'result.json'),'_dir_name':name,\n                                     '_anatomy':anatomy(root/name),'_sampling':sampling({})})")
s=s.replace("selected = {a:groups[(model,task,candidate_phase if a=='light' else baseline_phase,a)] for a in AGENTS}","selected = {a:[r for phase in (candidate_phases if a=='light' else [baseline_phase]) for r in groups[(model,task,phase,a)]] for a in AGENTS}")
s=s.replace("                prefix=f'{candidate_phase if agent==\"light\" else baseline_phase}-{model}-{task}-{agent}-r'\n                if any(name.startswith(prefix) for name in orphans): blockers.append(f'{agent}:unfinished_run_directory')", "                prefixes=[f'{phase}-{model}-{task}-{agent}-r' for phase in (candidate_phases if agent=='light' else [baseline_phase])]\n                if any(name.startswith(tuple(prefixes)) for name in orphans): blockers.append(f'{agent}:unfinished_run_directory')")
s=s.replace("(r['phase']==candidate_phase and r['agent']=='light')", "(r['phase'] in candidate_phases and r['agent']=='light')")
s=s.replace("'baseline_phase':baseline_phase,'candidate_phase':candidate_phase,", "'baseline_phase':baseline_phase,'candidate_phase':candidate_phase,'candidate_phases':candidate_phases,")
s=s.replace("'policy':'All result files in exactly selected phase/agent groups, including failures. No best-run selection.'", "'policy':'All result files in explicitly selected phase/agent groups, including reused screening failures. Duplicate repeat IDs and mixed source revisions block acceptance. No best-run selection.'")
s=s.replace("    for model in report['models']:\n", "    if len(report['selection'].get('candidate_phases',[])) > 1:\n        lines += ['Reused candidate phases: '+', '.join('`'+p+'`' for p in report['selection']['candidate_phases'])+'. Screening results are reused; this is a completed two-repeat matrix, not an independent fresh confirmation sample.','']\n    for model in report['models']:\n",1)
s=s.replace("    parser.add_argument('--candidate-phase')", "    parser.add_argument('--candidate-phase')\n    parser.add_argument('--reuse-candidate-phase',action='append',default=[],help='Reuse all Light results from another phase of the same source; duplicate repeats still block')")
s=s.replace('confirmatory=bool(args.confirmatory_phase))','confirmatory=bool(args.confirmatory_phase),reuse_candidate_phases=args.reuse_candidate_phase)')
# Self-test a true complementary phase, duplicate repeat and revision mismatch.
needle="        normal_record=root/'baseline-fixture-model-task-normal-r1/result.json'"
block="""        reused_dir=root/'candidate-final-fixture-model-task-light-r1'
        reused_record=reused_dir/'result.json'; reused_original=reused_record.read_text()
        reused=json.loads(reused_original); reused['phase']='candidate-screen'; reused['id']='candidate-screen-fixture-model-task-light-r1'
        reused_record.write_text(json.dumps(reused))
        reused_target=root/reused['id']; reused_dir.rename(reused_target)
        combined=summarize(root,['task'],'candidate-final','baseline',['fixture-model'],2,reuse_candidate_phases=['candidate-screen'])
        assert combined['accepted'] and combined['inventory']['selected_result_files']==6
        assert combined['models'][0]['totals']['light']['runs']==2
        reused['repeat']=2; (reused_target/'result.json').write_text(json.dumps(reused))
        duplicate=summarize(root,['task'],'candidate-final','baseline',['fixture-model'],2,reuse_candidate_phases=['candidate-screen'])
        assert not duplicate['owner_target_accepted'] and 'light:duplicate_repeats' in duplicate['models'][0]['tasks'][0]['blockers']
        reused['repeat']=1; reused['agent_revision']='different'; (reused_target/'result.json').write_text(json.dumps(reused))
        mixed=summarize(root,['task'],'candidate-final','baseline',['fixture-model'],2,reuse_candidate_phases=['candidate-screen'])
        assert not mixed['owner_target_accepted'] and 'light:mixed_agent_revisions' in mixed['models'][0]['tasks'][0]['blockers']
        reused_target.rename(reused_dir); reused_record.write_text(reused_original)
"""
s=s.replace(needle,block+needle)
p.write_text(s)
p=root/'test_packaging.py';s=p.read_text().replace("('repeats',0),", "('repeats',0),('repeat_start',0),")
needle='    def test_credential_removed_before_configuration_subprocesses(self):'
block="""    def test_repeat_start_keeps_completed_screening_ids_distinct(self):
        args=self.args(); args.repeat_start=2; args.repeats=1
        with mock.patch.object(runner,'cmd',side_effect=self.command):
            runner.configure(args)
        self.assertEqual(runner.PROVENANCE['repeat_start'],2)
        self.assertEqual(list(range(args.repeat_start,args.repeat_start+args.repeats)),[2])

"""
# Match helper names from this file below before inserting test.
p.write_text(s)
