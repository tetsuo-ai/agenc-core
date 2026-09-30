#!/usr/bin/env python3
"""Matched AgenC Light vs Pi panel on the direct Luna API (matched-v2).

matched-v2 differs from matched-v1 only in the Light config allow rule for
exec_command/write_stdin (v1 smoke: every shell call denied headless).

Successor of light-ultra/bench/luna-api/runner.py, which stays unchanged with
its results. Differences, all deliberate:
- Light keeps AgenC's ordinary sandbox and permission checks: acceptEdits,
  no --dangerously-bypass-approvals-and-sandbox.
- Startup flags precede `--` and the prompt (-p is boolean; parsing stops at
  the first positional token).
- Light runs one pinned, already built Linux Core tree (not a git checkout);
  its identity is dist/VERSION plus content digests.
- Task 12 is scored code-only for BOTH agents; planning evidence is reported
  separately and never changes a pass.
- Cells run as adjacent matched pairs: seeded task order, seeded agent order
  within each task. One Luna run at a time.
- A per-phase spend cap is checked before every cell, on top of the existing
  shared ledger, stop file and provider lock.
Credentials only enter through stdin_entry.py. Linux only.
"""
import argparse, datetime, fcntl, hashlib, json, os, pathlib, random, re, shutil, signal, subprocess, sys, time
from contextlib import contextmanager
from trace_checks import planning_evidence

HERE = pathlib.Path(__file__).resolve().parent
TASKS_DIR = HERE / 'tasks'
OBSERVER = HERE / 'direct.mjs'
OBSERVER_SHA256 = 'bcbe835a4694fdfe187a75178418b3d9d1a911ee53bb31719441ea915d6505c7'
PI_VERSION = '0.73.1'
MODEL = 'gpt-6-luna'
BASE_URL = 'https://api.openai.com/v1'
LIGHT_CONFIG = ('config_version = 2\nmodel = "gpt-6-luna"\nmodel_provider = "openai"\nreasoning_effort = "low"\n'
                'reasoning_summary = "auto"\nlight_reasoning_policy = "fixed"\nmax_output_tokens = 8192\n'
                # Ordinary allow rule, not a bypass: acceptEdits auto-allows edits only, and the
                # sandbox auto-allow covers the Bash tool, not Light's exec_command. Commands still
                # run in the OS sandbox; escalation requests still need an approver (none headless).
                '\n[permissions]\nallow = ["exec_command", "write_stdin"]\n')
KEY = ''
ROOT = LIGHT_CORE = PI_PREFIX = None
MAX_CALLS = 45
SPEND_CAP = 2.0
PROVENANCE = {}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def tree_digest(root):
    h = hashlib.sha256()
    for p in sorted(root.rglob('*')):
        if p.is_file() and not p.is_symlink():
            h.update(str(p.relative_to(root)).encode() + b'\0' + sha(p.read_bytes()).encode() + b'\n')
    return h.hexdigest()


def write_json(p, v):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(v, indent=2) + '\n')


def cmd(args, cwd=None, env=None, timeout=180, output=None):
    return subprocess.run(args, cwd=cwd, env=env, timeout=timeout, stdout=output or subprocess.PIPE,
                          stderr=subprocess.STDOUT, text=True)


def ledger_rows():
    p = ROOT / 'luna-api-ledger.jsonl'
    return [json.loads(x) for x in p.read_text().splitlines() if x.strip()] if p.exists() else []


def phase_spend(phase):
    rows = ledger_rows()
    settled = {r['id']: r for r in rows if r['event'] == 'settle'}
    return sum(settled.get(r['id'], {}).get('budget_charge_usd', r['reserve'])
               for r in rows if r['event'] == 'admit' and r['run'].startswith(phase + '-'))


@contextmanager
def provider_lock():
    lock = ROOT / 'locks' / 'openai.lock'
    lock.parent.mkdir(parents=True, exist_ok=True)
    with lock.open('a') as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError('Another runner owns the OpenAI provider lock') from error
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def one(task, agent, repeat, phase):
    rid = f'{phase}-{MODEL}-{task["id"]}-{agent}-r{repeat}'
    d = ROOT / 'runs' / rid
    prompt_sha = sha(task['prompt'].encode())
    if (d / 'result.json').exists():
        existing = json.loads((d / 'result.json').read_text())
        if existing.get('prompt_sha256') != prompt_sha or existing.get('configuration_sha256') != PROVENANCE['configuration_sha256']:
            raise RuntimeError('Existing result identity differs; use a new phase: ' + rid)
        return existing
    if d.exists():
        raise RuntimeError('Incomplete attempt preserved; use a new phase: ' + rid)
    if shutil.disk_usage(ROOT).free < 10 * 1024**3:
        raise RuntimeError('Stopped: less than 10 GiB free')
    if (ROOT / 'luna-api-stop.json').exists():
        raise RuntimeError('Luna stop file present: inspect it before resuming unstarted cells')
    spent = phase_spend(phase)
    if spent >= SPEND_CAP:
        raise RuntimeError(f'Phase spend cap reached: {spent:.6f} >= {SPEND_CAP}')
    d.mkdir(parents=True)
    repo, home = d / 'repo', d / 'home'
    home.mkdir()
    cache = ROOT / 'repos' / task['repo_sha']
    if cmd(['git', 'rev-parse', 'HEAD'], cwd=cache).stdout.strip() != task['repo_sha']:
        raise RuntimeError('Repository cache is not at the pinned revision: ' + task['repo_sha'])
    if cmd(['git', 'clone', '-q', '--no-hardlinks', str(cache), str(repo)]).returncode:
        raise RuntimeError('Fresh task clone failed ' + rid)
    if cmd(['git', 'checkout', '-q', task['repo_sha']], cwd=repo).returncode:
        raise RuntimeError('Pinned checkout failed ' + rid)
    setup = cmd([sys.executable, str(TASKS_DIR / task['setup_script']), str(repo)], timeout=120)
    (d / 'setup.log').write_text(setup.stdout)
    if setup.returncode:
        raise RuntimeError('Task setup failed ' + rid)
    env = {k: v for k, v in os.environ.items() if not any(s in k for s in ('KEY', 'TOKEN', 'SECRET'))}
    env.update(HOME=str(home), USER='benchmark', LOGNAME='benchmark', AGENC_HOME=str(home / 'agenc'),
               PI_CODING_AGENT_DIR=str(home / 'pi'), PI_SKIP_VERSION_CHECK='1', PI_TELEMETRY='0', PI_OFFLINE='1', CI='1',
               OPENAI_API_KEY=KEY, OPENAI_BASE_URL=BASE_URL, NODE_OPTIONS='--import=' + str(OBSERVER),
               LUNA_LEDGER_ROOT=str(ROOT), LUNA_RUN_DIR=str(d), LUNA_RUN_ID=rid, LUNA_TASK_CALL_CAP=str(MAX_CALLS),
               LUNA_ALLOW_ADAPTIVE='0', LUNA_ADAPTIVE_HIGH='0',
               # Light product defaults on OpenAI, stated explicitly: replay on, session-tail cache off.
               AGENC_EFFORT_LEVEL='low', AGENC_MAX_OUTPUT_TOKENS='8192', AGENC_OPENAI_REASONING_REPLAY='1',
               AGENC_CACHE_SESSION_TAIL='0', AGENC_LIGHT_REASONING_POLICY='fixed')
    if agent == 'pi':
        write_json(home / 'pi/models.json', {'providers': {'openai': {'baseUrl': BASE_URL, 'api': 'openai-responses',
                   'apiKey': 'OPENAI_API_KEY', 'models': [{'id': MODEL, 'reasoning': True, 'contextWindow': 1050000,
                                                          'maxTokens': 8192, 'compat': {}}]}}})
        args = [str(PI_PREFIX / 'node_modules/.bin/pi'), '--provider', 'openai', '--model', MODEL, '--thinking', 'low',
                '--mode', 'json', '--no-session', '-p', task['prompt']]
    else:
        # The owner authorized these task-owned repositories for benchmark edits.
        trust = home / 'agenc/trusted-projects.json'
        write_json(trust, {'version': 1, 'trustedProjects': [{'path': str(repo),
                   'trustedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}]})
        trust.chmod(0o600)
        config = d / 'agenc-config.toml'
        with config.open('x', encoding='utf-8') as handle:
            handle.write(LIGHT_CONFIG)
        args = ['node', str(LIGHT_CORE / 'runtime/bin/agenc'), '-p', '--light', '--provider', 'openai', '--model', MODEL,
                '--config', str(config), '--permission-mode', 'acceptEdits', '--output-format', 'json', '--', task['prompt']]
    write_json(d / 'argv.json', {'argv': args[:-1] + ['<prompt sha256 ' + prompt_sha + '>']})
    load_start = os.getloadavg()
    start = time.monotonic()
    rc, timeout = None, False
    with (d / 'agent.log').open('w') as log:
        p = subprocess.Popen(args, cwd=repo, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            rc = p.wait(timeout=task.get('timeout_seconds', 300))
        except subprocess.TimeoutExpired:
            timeout = True
            os.killpg(p.pid, signal.SIGTERM)
            try:
                rc = p.wait(timeout=15)
            except subprocess.TimeoutExpired:
                os.killpg(p.pid, signal.SIGKILL)
                rc = p.wait()
    wall = time.monotonic() - start
    if agent == 'light':
        with (d / 'daemon-stop.log').open('w') as log:
            try:
                cmd(['node', str(LIGHT_CORE / 'runtime/bin/agenc'), 'daemon', 'stop'], env=env, output=log, timeout=25)
            except subprocess.TimeoutExpired:
                pass
    check = cmd([sys.executable, str(TASKS_DIR / task['check_script']), str(repo)], timeout=120)
    (d / 'check.log').write_text(check.stdout)
    admitted = lambda: sum(1 for r in ledger_rows() if r['event'] == 'admit' and r['run'] == rid)
    deadline = time.monotonic() + 210
    while len(list(d.glob('usage-*.json'))) < admitted() and time.monotonic() < deadline:
        time.sleep(0.25)
    records = [json.loads(p.read_text()) for p in sorted(d.glob('usage-*.json'))]
    calls = admitted()
    stop = ROOT / 'luna-api-stop.json'
    budget_stop = stop.exists()
    result = {'id': rid, 'phase': phase, 'task': task['id'], 'category': task['category'], 'agent': agent, 'model': MODEL,
              'repeat': repeat, 'prompt_sha256': prompt_sha, 'configuration_sha256': PROVENANCE['configuration_sha256'],
              'agent_identity': PROVENANCE['agents'][agent],
              'pass': check.returncode == 0 and rc == 0 and not timeout and not budget_stop,
              'check_pass': check.returncode == 0, 'exit_code': rc, 'timeout': timeout, 'budget_stop': budget_stop,
              'stop_reason': json.loads(stop.read_text()).get('reason') if budget_stop else None,
              'wall_seconds': wall, 'load_start': load_start, 'load_end': os.getloadavg(),
              'model_calls': len(records), 'admitted_calls': calls,
              'provider_errors': sum(bool(r['error']) for r in records),
              'usage_complete': len(records) == calls and all(not r['usage_missing'] for r in records)}
    for k in ('input_tokens', 'cached_tokens', 'uncached_tokens', 'output_tokens', 'tool_calls', 'cost_usd', 'budget_charge_usd'):
        result[k] = sum(r[k] for r in records if r[k] is not None)
    result['cost_basis'] = 'official-openai-api-list-rate'
    if not result['usage_complete']:
        result['cost_usd'] = None
    if (d / 'wire-001.json').exists():
        body = json.loads((d / 'wire-001.json').read_text())['body']
        result['first_system_chars'] = len(body.get('instructions', '')) + sum(
            len(json.dumps(m.get('content', ''))) for m in body.get('input', []) if m.get('role') in ('system', 'developer'))
        result['first_schema_chars'] = len(json.dumps(body.get('tools', [])))
        result['sampling'] = {k: body.get(k) for k in ('model', 'max_output_tokens', 'reasoning', 'temperature', 'top_p')}
        result['initial_tools'] = [t.get('function', t)['name'] for t in body.get('tools', []) if 'name' in t.get('function', t)]
    if task.get('deferred_capability'):
        result['planning_evidence'] = planning_evidence(d, agent)
        result['planning_scored'] = False
    write_json(d / 'result.json', result)
    print(json.dumps({k: result[k] for k in ('id', 'pass', 'check_pass', 'exit_code', 'timeout', 'wall_seconds',
                                             'model_calls', 'cost_usd', 'usage_complete')}), flush=True)
    return result


def parser():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--root', type=pathlib.Path, required=True, help='Shared Luna ledger/runs root')
    ap.add_argument('--light-core', type=pathlib.Path, required=True, help='Pinned built Core tree')
    ap.add_argument('--light-commit', required=True, help='Expected dist/VERSION commit')
    ap.add_argument('--pi-prefix', type=pathlib.Path, required=True)
    ap.add_argument('--phase', required=True, help='matched-NAME; use a new name for every changed configuration')
    ap.add_argument('--agents', default='light,pi')
    ap.add_argument('--tasks', default='')
    ap.add_argument('--repeats', type=int, default=1)
    ap.add_argument('--repeat-start', type=int, default=1)
    ap.add_argument('--max-calls', type=int, default=45)
    ap.add_argument('--spend-cap-usd', type=float, default=2.0, help='Hard cap for this phase, from the shared ledger')
    ap.add_argument('--seed', type=int, default=30092026)
    ap.add_argument('--validate-only', action='store_true')
    return ap


def configure(args):
    global ROOT, LIGHT_CORE, PI_PREFIX, MAX_CALLS, SPEND_CAP, PROVENANCE
    if sys.platform != 'linux':
        raise RuntimeError('Benchmarks must run on Linux')
    if not re.fullmatch(r'matched-[A-Za-z0-9_-]+', args.phase):
        raise ValueError('Use a matched-NAME phase')
    if args.repeats < 1 or args.repeat_start < 1 or args.max_calls < 1 or not 0 < args.spend_cap_usd <= 10:
        raise ValueError('Invalid repeats, max calls or spend cap')
    ROOT, LIGHT_CORE, PI_PREFIX = args.root.resolve(), args.light_core.resolve(), args.pi_prefix.resolve()
    MAX_CALLS, SPEND_CAP = args.max_calls, args.spend_cap_usd
    if sha(OBSERVER.read_bytes()) != OBSERVER_SHA256:
        raise ValueError('Observer bytes changed')
    tasks = json.loads((TASKS_DIR / 'manifest.json').read_text())['tasks']
    ids = [t['id'] for t in tasks]
    selected = args.tasks.split(',') if args.tasks else ids
    agents = args.agents.split(',')
    if len(set(selected)) != len(selected) or any(t not in ids for t in selected):
        raise ValueError('Invalid task selector')
    if len(set(agents)) != len(agents) or any(a not in ('light', 'pi') for a in agents):
        raise ValueError('Invalid agent selector')
    tasks = [t for t in tasks if t['id'] in selected]
    for task in tasks:
        if not re.fullmatch(r'[A-Za-z0-9_-]+', task['id']):
            raise ValueError('Unsafe task ID')
        for field in ('setup_script', 'check_script'):
            path = (TASKS_DIR / task[field]).resolve()
            if not path.is_relative_to(TASKS_DIR) or not path.is_file():
                raise ValueError('Task script escapes manifest directory or is missing')
    version = json.loads((LIGHT_CORE / 'runtime/dist/VERSION').read_text())
    if version.get('commit') != args.light_commit or not (LIGHT_CORE / 'runtime/bin/agenc').is_file():
        raise ValueError('Light Core build identity mismatch')
    pi_package = PI_PREFIX / 'node_modules/@mariozechner/pi-coding-agent'
    if json.loads((pi_package / 'package.json').read_text())['version'] != PI_VERSION or not (PI_PREFIX / 'node_modules/.bin/pi').exists():
        raise ValueError('Install pinned Pi ' + PI_VERSION + ' in --pi-prefix')
    harness = sorted([*HERE.glob('*.py'), *HERE.glob('*.mjs'), *TASKS_DIR.rglob('*.py'), TASKS_DIR / 'manifest.json'])
    PROVENANCE = {
        'schema_version': 1, 'phase': args.phase, 'model': MODEL, 'provider': 'openai-direct',
        'harness_files_sha256': {str(p.relative_to(HERE)): sha(p.read_bytes()) for p in harness if '__pycache__' not in p.parts},
        'observer_sha256': OBSERVER_SHA256,
        'agents': {
            'light': {'version': version, 'dist_agenc_js_sha256': sha((LIGHT_CORE / 'runtime/dist/bin/agenc.js').read_bytes()),
                      'runtime_src_tree_sha256': tree_digest(LIGHT_CORE / 'runtime/src'),
                      'flags': ['-p', '--light', '--provider', 'openai', '--model', MODEL, '--config', '<per-run>',
                                '--permission-mode', 'acceptEdits', '--output-format', 'json', '--'],
                      'config_sha256': sha(LIGHT_CONFIG.encode()), 'sandbox': 'ordinary (default workspace-write); allow rule exec_command, write_stdin'},
            'pi': {'version': PI_VERSION, 'package_tree_sha256': tree_digest(pi_package),
                   'flags': ['--provider', 'openai', '--model', MODEL, '--thinking', 'low', '--mode', 'json', '--no-session', '-p'],
                   'sandbox': 'none (Pi has no sandbox)'},
        },
        'settings': {'reasoning_effort': 'low', 'reasoning_summary': 'auto', 'output_cap': 8192, 'max_calls_per_cell': MAX_CALLS},
        'tasks': selected, 'agent_set': agents, 'repeats': args.repeats, 'repeat_start': args.repeat_start, 'seed': args.seed,
        'spend_cap_usd': SPEND_CAP, 'scoring': 'code-only pass for every task and agent; task 12 planning reported, not scored',
        'node_version': cmd(['node', '--version']).stdout.strip(), 'python_version': sys.version.split()[0],
    }
    PROVENANCE['configuration_sha256'] = sha(json.dumps(PROVENANCE, sort_keys=True).encode())
    return tasks, agents


def schedule(tasks, agents, args):
    rng = random.Random(args.seed)
    jobs = []
    for repeat in range(args.repeat_start, args.repeat_start + args.repeats):
        order = list(tasks)
        rng.shuffle(order)
        for task in order:
            pair = list(agents)
            rng.shuffle(pair)
            jobs += [(task, agent, repeat) for agent in pair]
    return jobs


def main():
    global KEY
    args = parser().parse_args()
    KEY = os.environ.pop('OPENAI_API_KEY', '')
    tasks, agents = configure(args)
    jobs = schedule(tasks, agents, args)
    with provider_lock():
        provenance = ROOT / f'provenance-{args.phase}.json'
        if provenance.exists():
            if json.loads(provenance.read_text()) != PROVENANCE:
                raise RuntimeError('Existing phase provenance differs; use a new phase')
        else:
            with provenance.open('x') as handle:
                handle.write(json.dumps(PROVENANCE, indent=2) + '\n')
        print(json.dumps({'configuration_sha256': PROVENANCE['configuration_sha256'],
                          'schedule': [f'{t["id"]}:{a}:r{r}' for t, a, r in jobs]}), flush=True)
        if args.validate_only:
            KEY = ''
            print(json.dumps({'validation': 'pass', 'provider_calls': 0}))
            return
        if not KEY:
            raise RuntimeError('Missing OpenAI process credential')
        try:
            for task, agent, repeat in jobs:
                one(task, agent, repeat, args.phase)
        finally:
            KEY = ''


if __name__ == '__main__':
    main()
