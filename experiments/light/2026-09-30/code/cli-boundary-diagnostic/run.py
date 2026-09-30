#!/usr/bin/env python3
"""Fresh-HOME one-response boundary diagnostic; run under --network=none.

No model quality, tool latency or whole-task performance claim. Both processes
use Linux CLOCK_MONOTONIC (Python monotonic_ns, Node hrtime.bigint). Persistent
diagnostic artifacts are new; original runs and keys are never read or changed.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tempfile
import time

HERE = Path(__file__).resolve().parent
PROMPT = 'Reply briefly without using any tools.'


def write(path, value):
    with path.open('x') as f:
        json.dump(value, f, indent=2, sort_keys=True)
        f.write('\n')


def measure(args, arm, repeat):
    # The shared evidence mount may intentionally have group-writable parents.
    # Do not chmod it or weaken Core's protected-directory checks. Fresh /tmp
    # task homes use mkdtemp's 0700 boundary; copy evidence after measurement.
    root = Path(tempfile.mkdtemp(prefix=f'lb-{arm}-r{repeat}-'))
    home = root / 'home'
    (home/'agenc').mkdir(parents=True)
    (home/'pi').mkdir()
    capture = root/'transport.jsonl'
    trust = home/'agenc/trusted-projects.json'
    write(trust, {'version': 1, 'trustedProjects': [{'path': str(root), 'trustedAt': '2026-09-30T00:00:00Z'}]})
    trust.chmod(0o600)
    config = root/'config.toml'
    with config.open('x') as f:
        f.write('config_version = 2\nreasoning_summary = "auto"\n')
    env = {k: os.environ[k] for k in ('PATH', 'LANG', 'LC_ALL', 'TZ') if k in os.environ}
    env.update(HOME=str(home), USER='benchmark', LOGNAME='benchmark', CI='1',
      AGENC_HOME=str(home/'agenc'), PI_CODING_AGENT_DIR=str(home/'pi'),
      OPENAI_API_KEY='synthetic-no-provider-credential', OPENAI_BASE_URL='https://api.openai.com/v1',
      AGENC_EFFORT_LEVEL='low', AGENC_MAX_OUTPUT_TOKENS='8192', AGENC_LIGHT_REASONING_POLICY='fixed',
      AGENC_OPENAI_REASONING_REPLAY='1', PI_SKIP_VERSION_CHECK='1', PI_TELEMETRY='0', PI_OFFLINE='1',
      LIGHT_BOUNDARY_CAPTURE=str(capture), NODE_OPTIONS='--import='+str(HERE/'transport.mjs'),
      AGENC_RUNTIME_TIMING=str(root/'runtime-timing'))
    cli = ['node', str(args.core/'runtime/bin/agenc')]
    if arm == 'light':
        command = cli + ['--config', str(config), '--provider', 'openai', '--model', 'gpt-6-luna',
          '-p', '--output-format', 'json', '--dangerously-bypass-approvals-and-sandbox', '--light', PROMPT]
    else:
        write(home/'pi/models.json', {'providers': {'openai': {'baseUrl': 'https://api.openai.com/v1',
          'api': 'openai-responses', 'apiKey': 'OPENAI_API_KEY', 'models': [{'id': 'gpt-6-luna',
          'reasoning': True, 'contextWindow': 1050000, 'maxTokens': 8192, 'compat': {}}]}}})
        command = [str(args.pi/'node_modules/.bin/pi'), '--provider', 'openai', '--model', 'gpt-6-luna',
          '--thinking', 'low', '--mode', 'json', '--no-session', '-p', PROMPT]
    start = time.monotonic_ns()
    before_load = os.getloadavg()
    timed_out = False
    with (root/'agent.log').open('x') as log:
        child = subprocess.Popen(command, cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT)
        try:
            code = child.wait(timeout=45)
        except subprocess.TimeoutExpired:
            timed_out = True
            child.kill()  # Only this diagnostic CLI, never a discovered process.
            code = child.wait()
    end = time.monotonic_ns()
    rows = [json.loads(line) for line in capture.read_text().splitlines()] if capture.exists() else []
    requests = [r for r in rows if r['stage'] == 'request_received']
    responses = [r for r in rows if r['stage'] == 'response_constructed']
    stop_code = None
    if arm == 'light':
        with (root/'daemon-stop.log').open('x') as log:
            try:
                stopped = subprocess.run(cli+['daemon', 'stop'], cwd=root, env=env,
                                         stdout=log, stderr=subprocess.STDOUT, timeout=30)
                stop_code = stopped.returncode
            except subprocess.TimeoutExpired:
                stop_code = 'timeout'
    valid = code == 0 and not timed_out and len(requests) == len(responses) == 1
    result = {'arm': arm, 'repeat': repeat, 'exit_code': code, 'timeout': timed_out,
      'cli_pid': child.pid, 'parent_start_ns': start, 'parent_end_ns': end,
      'wall_seconds': (end-start)/1e9, 'load_start': before_load, 'load_end': os.getloadavg(),
      'requests': len(requests), 'responses': len(responses), 'stop_exit_code': stop_code,
      'valid_single_response': valid, 'records_before_cleanup': rows,
      'pre_request_seconds': None, 'post_response_seconds': None}
    if valid:
        request = int(requests[0]['monotonic_ns'])
        response = int(responses[0]['monotonic_ns'])
        if not start <= request <= response <= end:
            result['valid_single_response'] = False
        else:
            result.update(pre_request_seconds=(request-start)/1e9,
                          post_response_seconds=(end-response)/1e9,
                          synthetic_response_construction_seconds=(response-request)/1e9)
    write(root/'result.json', result)
    shutil.copytree(root, args.output/f'{arm}-r{repeat}', symlinks=True)
    print(json.dumps(result), flush=True)
    if not result['valid_single_response'] or (arm == 'light' and stop_code != 0):
        raise RuntimeError('Diagnostic invalid or cleanup failed; preserve artifacts, do not continue')
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--core', type=Path, required=True)
    ap.add_argument('--pi', type=Path, required=True)
    ap.add_argument('--output', type=Path, required=True)
    args = ap.parse_args()
    if platform.system() != 'Linux':
        raise SystemExit('Linux network-disabled container required')
    if any(Path('/sys/class/net').glob('eth*')):
        raise SystemExit('Refusing a container with an Ethernet interface')
    args.output.mkdir(mode=0o700, exist_ok=False)
    revision = subprocess.check_output(['git', '-C', str(args.core), 'rev-parse', 'HEAD'], text=True).strip()
    if revision != '3a4215afb0a6b9b5de54714a6c576397b82e4da3':
        raise SystemExit('Unexpected frozen control source')
    dirty = subprocess.check_output(['git', '-C', str(args.core), 'status', '--porcelain'], text=True)
    if dirty:
        raise SystemExit('Dirty frozen control')
    write(args.output/'provenance.json', {'source': revision, 'network': 'none',
      'instrumented': True, 'scope': 'synthetic_single_response_not_benchmark_quality',
      'prompt_sha256': hashlib.sha256(PROMPT.encode()).hexdigest(),
      'files': {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in (HERE/'run.py', HERE/'transport.mjs')}})
    for repeat in range(1, 4):
        for arm in (('light', 'pi') if repeat % 2 else ('pi', 'light')):
            measure(args, arm, repeat)


if __name__ == '__main__':
    main()
