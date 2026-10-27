#!/usr/bin/env python3
"""Run one native Kimi fixture through the built CLI, never an agent substitute.

Supply MOONSHOT_API_KEY only through the environment. Start a fresh isolated
daemon with the wire preload before the first run. See README.md.
"""
import argparse
import json
import os
import pathlib
import re
import shutil
import signal
import subprocess
import time
import urllib.request
import urllib.error
from fixtures import TASKS, prepare, grade, long_prompt

ROOT = pathlib.Path(__file__).resolve().parents[3]
HERE = pathlib.Path(__file__).resolve().parent


def cli_command(model):
    # Machine-readable output sets AgenC's existing exactOutput contract. The
    # independent fixture grader owns acceptance instead of a prose checklist
    # that contradicts tasks requesting an exact reply.
    return ['node', str(ROOT/'runtime/bin/agenc'), '-p', '--output-format', 'json',
            '--bypass-approvals', '--light', '--task-max-calls', '24',
            '--deadline', '+300', '--deadline-reserve', '1s', '--model', 'kimi:'+model]


def completion_warning(log):
    return 'completion gate exhausted' in log or 'completion gate settled as partial' in log


def read_back_observed(calls, filename):
    results = {m.get('toolCallId'): m.get('toolOutput', '')
               for call in calls for m in call.get('messages', []) if m.get('role') == 'tool'}
    for call in calls:
        for tool in call.get('tools', []):
            output = results.get(tool.get('id'), '')
            # An attempted read that failed does not establish read-back.
            if 'AGENC_DATA' not in output or re.search(r'\[exit (?!0\])', output):
                continue
            try:
                args = json.loads(tool['arguments'])
            except (ValueError, KeyError):
                continue
            if tool['name'] == 'FileRead' and pathlib.Path(args.get('file_path', args.get('path', ''))).name == filename:
                return True
            if tool['name'] in ('Bash', 'Shell', 'Terminal', 'exec_command'):
                command = args.get('cmd', args.get('command', ''))
                if 'cat ' in command and filename in command:
                    return True
    return False


class ProviderError(Exception):
    def __init__(self, status, error):
        self.status = status
        self.error_type = error.get('type', 'unknown')
        self.funds = 'insufficient balance' in error.get('message', '').lower()
        super().__init__(f'Moonshot HTTP {status}: {self.error_type}; funds={self.funds}')


def api(path, body=None):
    req = urllib.request.Request('https://api.moonshot.ai/v1/'+path,
        data=None if body is None else json.dumps(body).encode(),
        headers={'Authorization': 'Bearer '+os.environ['MOONSHOT_API_KEY'], 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=45) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        try:
            payload = json.load(error).get('error', {})
        except (ValueError, OSError):
            payload = {}
        raise ProviderError(error.code, payload) from None


def save(path, value):
    path.write_text(json.dumps(value, indent=2)+'\n')


def calibrate(model, quota_probe, target=98000, seed=0):
    records = 6500
    estimates = []
    for attempt in range(4):
        prompt, _ = long_prompt(records, seed)
        try:
            estimate = api('tokenizers/estimate-token-count', {'model': model, 'messages': [{'role':'user','content':prompt}]})
        except ProviderError as error:
            if not quota_probe or not error.funds:
                raise
            # A refusal probe is not a measured 100k context result.
            records = 4200
            estimates.append({'status': error.status, 'errorType': error.error_type,
                              'funds': True, 'tokens': None, 'fallbackRecords': records})
            return records, estimates
        tokens = estimate['data']['total_tokens']
        if not isinstance(tokens, (int, float)) or tokens <= 0:
            raise ValueError('Invalid tokenizer response')
        estimates.append({'records': records, 'tokens': tokens})
        if target * 0.979 <= tokens <= target * 1.031:
            return records, estimates
        records = max(100, round(records*target/tokens))
    raise ValueError('Could not calibrate long prompt')


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--sweep', type=pathlib.Path, required=True)
    p.add_argument('--evidence', type=pathlib.Path, required=True)
    p.add_argument('--model', required=True)
    p.add_argument('--task', choices=TASKS, required=True)
    p.add_argument('--repeat', type=int, default=1)
    p.add_argument('--phase', choices=['before','after'], default='before')
    p.add_argument('--target-tokens', type=int, default=98000)
    p.add_argument('--seed', type=int, default=0)
    p.add_argument('--quota-probe', action='store_true', help='Allow a single refusal diagnostic when balance is zero')
    args = p.parse_args()
    sweep, out = args.sweep.resolve(), args.evidence.resolve()
    out.mkdir(parents=True, exist_ok=True)
    home = sweep/'home-zdr'
    assert home.is_dir()
    model_list = api('models')['data']
    assert args.model in [m['id'] for m in model_list], 'Model is not currently offered by native Moonshot'
    model_info = next(m for m in model_list if m['id'] == args.model)
    if args.task == 'long-context':
        assert 96000 <= args.target_tokens <= model_info['context_length'] - 32768
    save(out/'models-current.json', model_list)
    before = api('users/me/balance')['data']
    ledger_path = out/'ledger.json'
    if not ledger_path.exists():
        save(ledger_path, {'cap': 24, 'balanceFloor': 1, 'spent': 0.191416725,
                          'priorSpend': 0.191416725, 'lastBalance': before})
    ledger = json.loads(ledger_path.read_text())
    if ledger.get('pending'):
        raise SystemExit('Unsettled reservation: reconcile the previous request before continuing')
    if ledger['spent'] >= ledger['cap']:
        raise SystemExit('Owner spend cap reached')
    if before['available_balance'] <= ledger.get('balanceFloor', 1) and not args.quota_probe:
        raise SystemExit('Moonshot balance floor reached')
    if before['available_balance'] <= 0 and not args.quota_probe:
        raise SystemExit('Moonshot account needs funding')
    label = f'{args.phase}-{args.model}-{args.task}-{args.repeat}'
    run = out/label
    if run.exists():
        raise SystemExit('Run already exists; use a new repeat number')
    run.mkdir()
    slot = TASKS.index(args.task)+1
    work = sweep/f'slot-zdr-{slot}'
    assert work.is_dir() and not work.is_symlink()
    prior = run/'prior-slot'
    prior.mkdir()
    for child in work.iterdir():
        if child.name not in ('.git', '.agenc'):
            shutil.move(str(child), str(prior/child.name))
    env = {'PATH': os.environ['PATH'], 'HOME': str(home), 'AGENC_HOME': str(home),
           'MOONSHOT_API_KEY': os.environ['MOONSHOT_API_KEY'], 'AGENC_MAX_OUTPUT_TOKENS': '4096',
           'NODE_OPTIONS': '--import='+str(HERE/'wire.mjs'), 'KIMI_SWEEP_CONTROL': str(out/'control.json')}
    if 'AGENC_KIMI_CACHE_TTL' in os.environ:
        env['AGENC_KIMI_CACHE_TTL'] = os.environ['AGENC_KIMI_CACHE_TTL']
    # Node tool processes need no provider credentials when grading fixtures.
    grade_env = {k:v for k,v in env.items() if k not in ('MOONSHOT_API_KEY','NODE_OPTIONS','KIMI_SWEEP_CONTROL')}
    records = 6500
    if args.task == 'long-context':
        records, estimates = calibrate(args.model, args.quota_probe, args.target_tokens, args.seed)
        save(run/'token-estimates.json', estimates)
    spec = prepare(work, args.task, records, args.seed)
    (run/'prompt.txt').write_text(spec['prompt'])
    save(run/'fixture.json', {k:v for k,v in spec.items() if k != 'prompt'})
    wire = out/'wire.jsonl'
    save(out/'control.json', {'run': label, 'wire': str(wire), 'ledger': str(ledger_path), 'quotaProbe': args.quota_probe})
    command = cli_command(args.model)
    if spec['image']:
        command += ['--image', spec['image']]
    started = time.monotonic()
    with (run/'cli.log').open('w') as log:
        proc = subprocess.Popen(command, cwd=work, env=env, stdin=subprocess.PIPE, stdout=log,
                                stderr=subprocess.STDOUT, start_new_session=True, text=True)
        try:
            proc.communicate(spec['prompt'], timeout=320)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGTERM)
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait()
    seconds = round(time.monotonic()-started, 3)
    for attempt in range(60):
        if not json.loads(ledger_path.read_text()).get('pending'):
            break
        time.sleep(0.5)
    after = api('users/me/balance')['data']
    events = [json.loads(line) for line in wire.read_text().splitlines()] if wire.exists() else []
    events = [e for e in events if e['run'] == label]
    calls = [e for e in events if isinstance(e.get('status'), int)]
    usages = [c.get('usage', {}) for c in calls]
    ok, detail = grade(work, args.task, spec, grade_env)
    received_reasoning = {e['reasoningHash'] for e in calls if e.get('reasoningLength',0)>0}
    replays = sum(m.get('reasoningHash') in received_reasoning for c in calls for m in c.get('messages',[]) if m.get('reasoningLength',0)>0)
    tool_history = '\n'.join(m.get('toolOutput','') for c in calls for m in c.get('messages',[]))
    tool_calls = [t for c in calls for t in c.get('tools',[])]
    read_back = read_back_observed(calls, 'hello.txt' if args.task == 'file' else 'answer.json')
    test_run = any('node check.mjs' in t['arguments'] for t in tool_calls)
    checks = {
        'file': read_back and bool(calls) and calls[-1].get('text', '').strip() == 'hi',
        'multi-file': test_run,
        'debug': test_run and 'AssertionError' in tool_history and 'PASS debug' in tool_history,
        'replay': replays >= 5 and all(f'PASS stage {i}' in tool_history for i in range(1,7)),
        'vision': any(c.get('images',0)>0 for c in calls) and read_back,
        'long-context': read_back,
    }
    warning = completion_warning((run/'cli.log').read_text())
    ok = ok and checks[args.task] and proc.returncode == 0 and not warning
    blocked = any('insufficient balance' in str(c.get('error','')).lower() for c in calls)
    result = {'run': label, 'phase': args.phase, 'model': args.model, 'task': args.task,
              'repeat': args.repeat, 'solve': ok, 'status': 'blocked-funds' if blocked else ('solved' if ok else 'failed'),
              'rc': proc.returncode, 'calls': len(calls), 'input': sum(u.get('prompt_tokens',0) for u in usages),
              'output': sum(u.get('completion_tokens',0) for u in usages),
              'cached': sum(u.get('prompt_tokens_details',{}).get('cached_tokens',u.get('cached_tokens',0)) for u in usages),
              'cost': sum(c.get('cost',0) for c in calls), 'seconds': seconds, 'reasoningReplays': replays,
              'completionWarning': warning,
              'seed': args.seed, 'targetTokens': args.target_tokens if args.task == 'long-context' else None,
              'balanceBefore': before, 'balanceAfter': after, 'grader': detail, 'behaviorVerified': checks[args.task]}
    save(run/'result.json', result)
    with (out/'results.jsonl').open('a') as f:
        f.write(json.dumps(result)+'\n')
    # Save only task artifacts. Isolated runtime state and credentials stay out.
    artifacts = run/'artifacts'
    artifacts.mkdir()
    for child in work.iterdir():
        if child.name not in ('.git','.agenc'):
            if child.is_dir():
                shutil.copytree(child, artifacts/child.name)
            else:
                shutil.copy2(child, artifacts/child.name)
    print(json.dumps({k:v for k,v in result.items() if k not in ('grader','balanceBefore','balanceAfter')}), flush=True)


if __name__ == '__main__':
    main()
