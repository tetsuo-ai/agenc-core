#!/usr/bin/env python3
"""Diagnostic cache hypothesis: same frozen source, no runtime edits."""
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
fixture_dir = HERE.parent/'cli-boundary-diagnostic-v3'
ab_path = HERE.parent/'cli-boundary-startup-ab-v3/ab.py'
core = Path('/work/core-converge-fixedpolicy')
expected = '3a4215afb0a6b9b5de54714a6c576397b82e4da3'
assert subprocess.check_output(['git', '-C', str(core), 'rev-parse', 'HEAD'], text=True).strip() == expected
assert not subprocess.check_output(['git', '-C', str(core), 'status', '--porcelain'], text=True)
pins = {fixture_dir/'run.py': 'fd30b5e55fc126fa07daaf44ec4963727ce8d537573b5c6d29588f79f6147a3e',
        fixture_dir/'transport.mjs': 'c89d853a75ed765e4556cad245e956e005af9383ae5f8f195c883ec16cbae8dd',
        ab_path: 'e01df2cee4e364b6bb159fdf748bcb4b8db2b08d4386bf19a7d77096a4dcf5fc'}
for p, digest in pins.items():
    assert hashlib.sha256(p.read_bytes()).hexdigest() == digest
assert not any(Path('/sys/class/net').glob('eth*'))
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
fixture = load('fixture', fixture_dir/'run.py')
ab = load('ab', ab_path)
fixture.subprocess = SimpleNamespace(Popen=ab.BlockingWaitPopen,
    TimeoutExpired=subprocess.TimeoutExpired, run=subprocess.run, STDOUT=subprocess.STDOUT)
output = HERE/'results'
output.mkdir(mode=0o700, exist_ok=False)
for arm in ('control', 'cache'):
    (output/arm).mkdir(mode=0o700)
fixture.write(output/'provenance.json', {'source': expected, 'scope': 'compile_cache_hypothesis_not_production',
    'repeats': 3, 'new_private_cache_per_sample': True,
    'scripts': {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in
        (*pins, HERE/'run.py', HERE/'transport.mjs')}})
results = []
for repeat in range(1, 4):
    for arm in (('control', 'cache') if repeat % 2 else ('cache', 'control')):
        fixture.HERE = fixture_dir if arm == 'control' else HERE
        result = fixture.measure(SimpleNamespace(core=core, output=output/arm), 'light', repeat)
        results.append({'variant': arm, **result})
fixture.write(output/'summary.json', results)
print(json.dumps({'completed_samples': len(results)}))
