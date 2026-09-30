"""Repair only observed pre-model failures within the declared socket risk set."""
import json
from pathlib import Path
import subprocess

root=Path(__file__).resolve().parent.parent
plan=json.loads((root/'evidence/socket-repair-plan.json').read_text())
validation='''import json,pathlib
plan=json.loads(PLAN_LITERAL)
root=pathlib.Path.home()/"claude-agenc-work/light-port/runs"
records=[json.loads(path.read_text()) for path in root.glob(plan["original_phase"]+"*/result.json")]
assert len(records)==48, "Original confirmation must finish first"
expected={(model,task,repeat) for cohort in plan["planned_repairs"] for model in cohort["models"] for task in cohort["tasks"] for repeat in cohort["repeats"]}
validated=[]
for record in records:
    assert record["agent_revision"]==plan["source"]
    key=(record["model"],record["task"],record["repeat"])
    if record["model_calls"]==0:
        assert key in expected, "Unexpected zero-call failure requires review"
        directory=root/record["id"]
        assert record["model_calls"]==0 and record["exit_code"]==1
        assert len(("/work/runs/"+record["id"]+"/home/agenc/daemon.sock").encode())>=108
        assert "connect EINVAL" in (directory/"agent.log").read_text()
        assert not list(directory.glob("usage-*.json"))
        validated.append(record["id"])
    else:
        assert record["model_calls"]>0, "Unexpected additional zero-call failure requires review"
assert validated
print(json.dumps({"original_attempts":48,"eligible_zero_call_failures":validated,"other_model_cells":48-len(validated)}))
'''.replace('PLAN_LITERAL',repr(json.dumps(plan)))
ssh=['ssh','-i','/Users/tetsuoarena/claude-agenc/pc-ssh/id_ed25519','-o','IdentitiesOnly=yes','paul@192.168.1.218','python3 -']
result=subprocess.run(ssh,input=validation,text=True,capture_output=True,check=True)
verified=json.loads(result.stdout)
with (root/'evidence/socket-repair-validation.json').open('x') as output:
    json.dump(verified,output,indent=2)
    output.write('\n')
eligible=set(verified['eligible_zero_call_failures'])
print(f"Validated {len(eligible)} zero-call socket failures; all model-bearing cells remain unchanged",flush=True)
for cohort in plan['planned_repairs']:
    phase=cohort['phase']
    models=[]
    for model in cohort['models']:
        ids={plan['original_phase']+'-'+model+'-'+task+'-light-r'+str(repeat) for task in cohort['tasks'] for repeat in cohort['repeats']}
        if not ids & eligible:continue
        if not ids <= eligible:raise SystemExit('Partial pair eligibility requires review before any further repair')
        models.append(model)
    if not models:continue
    command=['bash',str(root/'bench/run-cohort.sh'),phase,'core-local',','.join(cohort['tasks']),
             '2','1','0','harness-fast',','.join(models)]
    print('Start '+phase,flush=True)
    with (root/'evidence'/f'{phase}-launch.log').open('x') as log:
        process=subprocess.Popen(command,cwd=root,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
        for line in process.stdout:
            log.write(line);log.flush()
            try:value=json.loads(line)
            except ValueError:continue
            if 'id' in value and 'pass' in value:
                print(json.dumps({key:value.get(key) for key in ['id','pass','check_pass','wall_seconds','model_calls','input_tokens','output_tokens']}),flush=True)
            elif 'total_balance' in value:print(json.dumps(value),flush=True)
        code=process.wait()
        if code:raise SystemExit(f'{phase} exited {code}; no automatic retry')
    print('End '+phase,flush=True)
