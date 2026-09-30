"""Coordinator's one-operation disposition under the owner's Light continuation.

No provider calls or financial writes. Never retry an old attempt. The reviewed
helper retains admission blocking on an uncertain transition. Do not clear any
residual lock if this fails; inspect its evidence instead.
"""
import hashlib
import importlib.util
import json
import pathlib
import subprocess

ROOT = pathlib.Path('/home/paul/claude-agenc-work/light-ultra')
HERE = pathlib.Path(__file__).resolve().parent
FIX = '3a4215afb0a6b9b5de54714a6c576397b82e4da3'
PHASE = 'candidate-api-fixedpolicy'
PROVENANCE_HASH = '2ae50ffbb61a4200a1fc2deb467b704bf6e9b975c96793588f49a28a00863df2'
HELPER_HASH = '06b9243fdbd47d57c28f67573b330c3b8d36fd4a6cfe1be9eac72df240ab8fe3'
VALIDATION_HASH = 'b26ad2337d6ed9a0f675e8962e7df99e39a5cf1e3c663f5c03e16b731c9597e7'
GUARD_HASH = '47f012ac420a5103f6e69628e0f47168f269c0109f220bfb338b7611cb3ddc76'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def command(args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout.strip()


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def main():
    require(sha(HERE / 'resolve_stop.py') == HELPER_HASH, 'unreviewed helper')
    require(sha(HERE / 'fixed-policy-validation.json') == VALIDATION_HASH, 'unreviewed validation')
    build = ROOT / 'core-converge-fixedpolicy'
    require(command(['git', '-C', str(build), 'rev-parse', 'HEAD']) == FIX, 'candidate revision changed')
    require(not command(['git', '-C', str(build), 'status', '--porcelain']), 'candidate checkout dirty')
    require(not command(['docker', 'ps', '-q']), 'active Docker jobs')
    provenance_path = ROOT / f'provenance-{PHASE}-openai.json'
    require(sha(provenance_path) == PROVENANCE_HASH, 'preflight changed')
    provenance = json.loads(provenance_path.read_bytes())
    for name, expected in provenance['harness_files_sha256'].items():
        relative = pathlib.PurePosixPath(name)
        require(not relative.is_absolute() and '..' not in relative.parts, 'invalid harness path')
        require(sha(ROOT / 'luna-api-fixed-policy' / name) == expected, 'harness changed')
    require(sha(ROOT / 'build-converge-fixedpolicy.log') ==
            'b8ede94391d2efd6bdd687c3e3d4636a0147ab2de034d2a439777cd4ff9855ff', 'build log changed')
    require(sha(ROOT.parent / 'results/light-policy-3a4215a-focus.log') ==
            '0d0c13e5c2804560f827c63bf62ab4516b2388899f3ef0456c1df1aae6450eac', 'focus evidence changed')
    spec = importlib.util.spec_from_file_location('reviewed_stop', HERE / 'resolve_stop.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    # One reviewed invocation; the generic helper remains deny-by-default.
    module.REVIEWED_PRESEND_GUARDS = frozenset([GUARD_HASH])
    module.REVIEWED_FIX_VALIDATIONS = {FIX: VALIDATION_HASH}
    result = module.acknowledge_presend_stop(
        ROOT,
        expected_stop_sha256='e3c2925e9fe4e989175809d73f237e834a9008f2b9e3b4be0696a55d5a5bbe2f',
        expected_run='candidate-api-takeoverruntime-gpt-6-luna-04-count-by-light-r1',
        fix_sha=FIX,
        fresh_phase=PHASE,
        authority_id='owner-light-continuation-coordinator-reviewed-20260929',
        reviewed_guard_path=ROOT / 'luna-api/direct.mjs',
        fix_validation_path=HERE / 'fixed-policy-validation.json',
        expected_fresh_provenance_sha256=PROVENANCE_HASH,
        explicitly_authorized=True,
    )
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    main()
