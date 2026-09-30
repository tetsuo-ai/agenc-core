import pathlib,re,json
root=pathlib.Path('/home/paul/claude-agenc-work/light-runtime')
base=(root/'main.fails').read_text() if (root/'main.fails').exists() else pathlib.Path('/home/paul/claude-agenc-work/results/light-runtime-main.fails').read_text()
log=(root/'r2-full-live.log').read_text(errors='replace')
clean=re.sub(r'\x1b\[[0-9;]*m','',log)
failures=[s.strip() for s in clean.splitlines() if s.startswith(' FAIL ')]
baselines={s.strip() for s in base.splitlines()}
new=[s for s in failures if s not in baselines]
files=sorted(set(re.split(r'\s+',s)[1] for s in new if re.split(r'\s+',s)[1].startswith('tests/')))
report={'candidate_failures':failures,'not_in_baseline':new,'rerun_files':files,'summary':[s.strip() for s in clean.splitlines() if re.match(r'^\s*(?:Test Files|Tests|Duration)\s',s)]}
(root/'r2-triage.json').write_text(json.dumps(report,indent=2)+'\n')
(root/'r2-rerun-files.txt').write_text('\n'.join(files)+'\n')
print(json.dumps({'full_summary':report['summary'],'candidate_failure_cases':len(failures),'cases_not_in_baseline':len(new),'rerun_files':files},indent=2))
