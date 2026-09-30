#!/usr/bin/env python3
"""One offline Light CLI plus owned daemon CPU profiles, no provider calls."""
import hashlib
import importlib.util
from pathlib import Path
import subprocess
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
fixture_dir = HERE.parent/'cli-boundary-diagnostic-v3'
core = Path('/work/core-converge-fixedpolicy')
expected = '3a4215afb0a6b9b5de54714a6c576397b82e4da3'
assert subprocess.check_output(['git', '-C', str(core), 'rev-parse', 'HEAD'], text=True).strip() == expected
assert not subprocess.check_output(['git', '-C', str(core), 'status', '--porcelain'], text=True)
assert hashlib.sha256((fixture_dir/'run.py').read_bytes()).hexdigest() == 'fd30b5e55fc126fa07daaf44ec4963727ce8d537573b5c6d29588f79f6147a3e'
assert hashlib.sha256((fixture_dir/'transport.mjs').read_bytes()).hexdigest() == 'c89d853a75ed765e4556cad245e956e005af9383ae5f8f195c883ec16cbae8dd'
assert not any(Path('/sys/class/net').glob('eth*')), 'External network forbidden'
spec = importlib.util.spec_from_file_location('fixture', fixture_dir/'run.py')
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
fixture.HERE = HERE
output = HERE/'results'
output.mkdir(mode=0o700, exist_ok=False)
fixture.write(output/'provenance.json', {'source': expected, 'scope': 'cpu_profile_not_latency',
    'scripts': {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                for p in (HERE/'run.py', HERE/'transport.mjs')}})
fixture.measure(SimpleNamespace(core=core, output=output), 'light', 1)
profiles = sorted(output.glob('light-r1/*.cpuprofile'))
assert len(profiles) >= 3, 'Expected CLI, daemon and cleanup CLI profiles'
print('CPU profiles completed:', len(profiles))
