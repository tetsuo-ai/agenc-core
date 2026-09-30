"""Validate the new cohort without requiring favorable outcomes."""
import hashlib
import json
from pathlib import Path
root=Path.home()/'claude-agenc-work/light-port'
records=[json.loads(p.read_text()) for p in sorted((root/'runs').glob('candidate-eq-*/result.json'))]
assert len(records)==48
assert len({(r['model'],r['task'],r['repeat']) for r in records})==48
for r in records:
    assert r['agent_revision']=='3c954ea5591c683aa9b14a0219345e11051b06dd'
    p=r['provenance']
    assert p['task_manifest_sha256']=='d95dd4bd1ee0d61d6b149c7c38e0f1a23a71be0fca2d1d9d461728037f5358ab'
    assert p['reasoning_effort']=='high' and p['output_cap']==8192 and p['max_calls']==45
    assert p['spend_cap_usd']==15 and p['balance_floor_usd']==10
    assert p['balance_guard']=='one_live_check_before_task_launch_plus_local_reservations'
    for name,digest in p['harness_files_sha256'].items():
        assert hashlib.sha256((root/'harness-fair'/name).read_bytes()).hexdigest()==digest,name
    assert len(('/work/runs/'+r['id']+'/home/agenc/daemon.sock').encode())<100
    admission=json.loads((root/'runs'/r['id']/'balance-admission.json').read_text())
    assert admission['balance']>=10
    first=root/'runs'/r['id']/'usage-001.json'
    if first.exists():
        assert admission['checked_at']+admission['seconds'] < json.loads(first.read_text())['time']
ledger=[json.loads(l) for l in (root/'spend-deepseek.jsonl').read_text().splitlines()]
result={'source':records[0]['agent_revision'],'cells':48,'passed':sum(r['pass'] for r in records),
        'models':sorted({r['model'] for r in records}),'harness_sha256':records[0]['harness_sha256'],
        'manifest_sha256':records[0]['provenance']['task_manifest_sha256'],
        'guard_method':records[0]['provenance']['balance_guard'],
        'max_socket_bytes':max(len(('/work/runs/'+r['id']+'/home/agenc/daemon.sock').encode()) for r in records),
        'usage_complete':all(r['usage_complete'] for r in records),
        'provider_errors':sum(r['provider_errors'] for r in records),
        'zero_call_cells':[r['id'] for r in records if not r['model_calls']],
        'failed_cells':[r['id'] for r in records if not r['pass']],
        'lifetime_ledger_entries':len(ledger),
        'lifetime_observed_cost':sum(r.get('cost_usd') or 0 for r in ledger),
        'lifetime_reserved_charge':sum(r.get('budget_charge_usd',r.get('cost_usd') or 0) for r in ledger),
        'checks':['48 unique predeclared cells','unchanged source/effort/output/call caps','unchanged task/checker hashes','same lifetime ledger and limits','live floor check before requests','socket path below 100 bytes']}
assert result['lifetime_reserved_charge']<15
(root/'fair-provenance.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
