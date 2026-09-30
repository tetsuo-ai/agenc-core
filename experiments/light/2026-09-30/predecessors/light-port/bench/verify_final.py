"""Check the frozen source, tasks and paid harness in every final attempt."""
import hashlib
import json
from pathlib import Path

root = Path.home()/'claude-agenc-work/light-port'
paths = sorted((root/'runs').glob('candidate-local-confirmation*/result.json'))
paths += sorted((root/'runs').glob('candidate-local-confirm11*/result.json'))
assert len(paths) == 50
expected_source = '3c954ea5591c683aa9b14a0219345e11051b06dd'
expected_manifest = 'd95dd4bd1ee0d61d6b149c7c38e0f1a23a71be0fca2d1d9d461728037f5358ab'
records = [json.loads(path.read_text()) for path in paths]
for record in records:
    assert record['agent_revision'] == expected_source
    provenance = record['provenance']
    assert provenance['task_manifest_sha256'] == expected_manifest
    assert provenance['reasoning_effort'] == 'high'
    assert provenance['output_cap'] == 8192 and provenance['max_calls'] == 45
    for name, digest in provenance['harness_files_sha256'].items():
        assert hashlib.sha256((root/'harness-fast'/name).read_bytes()).hexdigest() == digest, name
    if record['model_calls']:
        assert record['pass'] and record['check_pass']
        assert record['usage_complete'] and not record['provider_errors']
model_records = [r for r in records if r['model_calls']]
assert len(model_records) == 48
assert len({(r['model'],r['task'],r['repeat']) for r in model_records}) == 48
report = dict(attempts=len(records), model_runs=len(model_records), startup_failures=2,
              source=expected_source, manifest=expected_manifest,
              checks=['retained source', 'frozen harness byte hashes', 'unchanged effort and caps',
                      '48 distinct logical model cells', 'complete usage', 'all effective and artifact checks pass'])
(root/'provenance-final.json').write_text(json.dumps(report, indent=2)+'\n')
print(json.dumps(report))
