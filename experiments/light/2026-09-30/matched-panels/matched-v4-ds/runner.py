#!/usr/bin/env python3
"""Matched AgenC Light vs Pi panel on DeepSeek Flash (matched-v4-ds). v4 adds --tasks-dir.

Same cell contract as matched-v3 (Luna): Light keeps AgenC's ordinary sandbox
(bubblewrap, acceptEdits, allow rule for exec_command/write_stdin, no bypass),
startup flags precede `--` and the prompt, one pinned Linux Core build, task 12
scored code-only for both agents, adjacent matched pairs in seeded order, one
cell at a time.

Provider access follows the historical converge runner: a loopback proxy in
this process holds the real key; agents only see a dummy key and a per-run
base URL. Every call is reserved in the existing deepseek-reservations.jsonl
before sending and settled in the existing spend-deepseek.jsonl at provider
list rate from provider usage. A live balance check precedes every cell; the
account floor is $1 (evaluation contract) plus a per-phase spend cap.
Credentials only enter through stdin_entry.py. Linux only.
"""
import argparse, datetime, fcntl, hashlib, http.server, json, os, pathlib, random, re, shutil, signal, subprocess, sys, threading, time, urllib.error, urllib.request
from contextlib import contextmanager
from trace_checks import planning_evidence

HERE = pathlib.Path(__file__).resolve().parent
TASKS_DIR = HERE / 'tasks'  # overridden by --tasks-dir
PI_VERSION = '0.73.1'
MODEL = 'deepseek-flash'
UPSTREAM_URL = 'https://api.deepseek.com/chat/completions'
LIGHT_CONFIG = ('config_version = 2\nmodel = "deepseek-flash"\nmodel_provider = "deepseek"\nreasoning_effort = "high"\n'
                'light_reasoning_policy = "fixed"\nmax_output_tokens = 8192\n'
                # Ordinary allow rule, not a bypass (see matched-v2): commands still run in the
                # OS sandbox; escalation requests still need an approver (none headless).
                '\n[permissions]\nallow = ["exec_command", "write_stdin"]\n')
KEY = ''
ROOT = LIGHT_CORE = PI_PREFIX = LEDGER = RESERVATIONS = None
PRICING = json.loads((HERE / 'pricing.json').read_text())
MAX_CALLS = 45
SPEND_CAP = 1.0
BALANCE_FLOOR = 1.0
PHASE = ''
PROVENANCE = {}
LOCK = threading.Lock()
ACTIVE = {}
SNAPSHOT = None


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


def append_durable(path, row):
    with path.open('a') as f:
        f.write(json.dumps(row) + '\n')
        f.flush()
        os.fsync(f.fileno())


def cmd(args, cwd=None, env=None, timeout=180, output=None):
    return subprocess.run(args, cwd=cwd, env=env, timeout=timeout, stdout=output or subprocess.PIPE,
                          stderr=subprocess.STDOUT, text=True)


def jsonl(path):
    return [json.loads(x) for x in path.read_text().splitlines() if x.strip()] if path.exists() else []


def settled_ids():
    return {(r['run'], r['call']) for r in jsonl(LEDGER) if 'run' in r and 'call' in r}


def pending_reservations():
    settled = settled_ids()
    return sum(r['reserve'] for r in jsonl(RESERVATIONS) if (r['run'], r['call']) not in settled)


def phase_spend():
    settled = {(r['run'], r['call']): r for r in jsonl(LEDGER) if r.get('run', '').startswith(PHASE + '-')}
    return sum(settled.get((r['run'], r['call']), {}).get('budget_charge_usd', r['reserve'])
               for r in jsonl(RESERVATIONS) if r['run'].startswith(PHASE + '-'))


def balance():
    req = urllib.request.Request('https://api.deepseek.com/user/balance', headers={'Authorization': 'Bearer ' + KEY})
    d = json.load(urllib.request.urlopen(req, timeout=30))
    usd = [b for b in d['balance_infos'] if b.get('currency') == 'USD'] or d['balance_infos']
    return {'is_available': d['is_available'], 'total_balance': float(usd[0]['total_balance']), 'currency': usd[0].get('currency')}


def rates(stamp):
    d = datetime.datetime.fromtimestamp(stamp, datetime.timezone.utc)
    peak = d.weekday() in PRICING['peak_weekdays_utc'] and any(a <= d.hour < b for a, b in PRICING['peak_hours_utc'])
    return [v * (PRICING['peak_multiplier'] if peak else 1) for v in PRICING['models'][MODEL]['usd_per_million_tokens']]


def reservation(body):
    peak = PRICING['peak_multiplier']
    rate = PRICING['models'][MODEL]['usd_per_million_tokens']
    output = body.get('max_tokens', body.get('max_completion_tokens', 8192))
    return (output * rate[2] * peak + len(json.dumps(body).encode()) * rate[1] * peak) / 1e6


class Proxy(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({'data': [{'id': MODEL}]}).encode())

    def do_POST(self):
        rid = self.path.split('/')[1]
        state = ACTIVE.get(rid)
        if state is None:
            self.send_error(404)
            return
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        if body.get('model') != MODEL:
            state['stop_reason'] = 'unexpected_model'
            self.send_error(400, 'Unexpected model refused')
            return
        stamp = time.time()
        with LOCK:
            reserve = reservation(body)
            available = SNAPSHOT['balance'] - pending_reservations() - reserve
            if available < BALANCE_FLOOR:
                state['stop_reason'] = 'balance_floor'
                self.send_error(429, 'Account balance floor reached')
                return
            if phase_spend() + reserve >= SPEND_CAP:
                state['stop_reason'] = 'spend_cap'
                self.send_error(429, 'Phase spend cap')
                return
            if state['calls'] >= MAX_CALLS:
                state['stop_reason'] = 'call_limit'
                self.send_error(429, 'Per-cell call limit')
                return
            state['calls'] += 1
            n = state['calls']
            append_durable(RESERVATIONS, {'run': rid, 'call': n, 'reserve': reserve, 'time': stamp})
            state['open'] += 1
        write_json(state['dir'] / f'wire-{n:03}.json', {'sent_at': stamp, 'body': body})
        req = urllib.request.Request(UPSTREAM_URL, data=json.dumps(body).encode(),
                                     headers={'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json'})
        usage, toolids, error = {}, set(), None
        timing = {'upstream_start_at': time.time(), 'response_headers_at': None, 'first_token_at': None, 'stream_end_at': None}
        try:
            with urllib.request.urlopen(req, timeout=180) as res:
                timing['response_headers_at'] = time.time()
                self.send_response(res.status)
                self.send_header('Content-Type', res.headers.get('Content-Type', 'text/event-stream'))
                self.end_headers()
                chunks = []
                for line in res:
                    chunks.append(line)
                    try:
                        self.wfile.write(line)
                        self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError):
                        pass
                    if line.startswith(b'data: '):
                        try:
                            event = json.loads(line[6:])
                        except ValueError:
                            continue
                        if timing['first_token_at'] is None and any(
                                any(c.get('delta', {}).get(k) for k in ('content', 'reasoning_content', 'tool_calls'))
                                for c in event.get('choices', [])):
                            timing['first_token_at'] = time.time()
                        if event.get('usage'):
                            usage = event['usage']
                        for c in event.get('choices', []):
                            for t in c.get('delta', {}).get('tool_calls', []) or []:
                                toolids.add(t.get('index', t.get('id')))
                timing['stream_end_at'] = time.time()
                raw = b''.join(chunks)
                if not body.get('stream'):
                    event = json.loads(raw)
                    usage = event.get('usage', {})
                    for c in event.get('choices', []):
                        for t in c.get('message', {}).get('tool_calls', []) or []:
                            toolids.add(t.get('id'))
                (state['dir'] / f'response-{n:03}.txt').write_bytes(raw)
        except urllib.error.HTTPError as e:
            error = {'status': e.code, 'body': e.read().decode(errors='replace')[:2000]}
            try:
                self.send_error(e.code)
            except OSError:
                pass
        except Exception as e:  # noqa: BLE001 - recorded, never retried
            error = {'type': type(e).__name__}
            try:
                self.send_error(502)
            except OSError:
                pass
        inp, out = usage.get('prompt_tokens', 0), usage.get('completion_tokens', 0)
        hit = usage.get('prompt_cache_hit_tokens', usage.get('prompt_tokens_details', {}).get('cached_tokens', 0))
        miss = usage.get('prompt_cache_miss_tokens', inp - hit)
        price = rates(stamp)
        cost = (hit * price[0] + miss * price[1] + out * price[2]) / 1e6 if usage else None
        rejected = bool(error and 400 <= error.get('status', 0) < 500)
        # Usage counts only when the required counters are present, finite and consistent.
        valid = (isinstance(usage.get('prompt_tokens'), int) and isinstance(usage.get('completion_tokens'), int)
                 and usage['prompt_tokens'] > 0 and usage['completion_tokens'] >= 0 and 0 <= hit <= inp)
        if not valid:
            cost = None
        record = {'run': rid, 'call': n, 'model': MODEL, 'input_tokens': inp, 'cached_tokens': hit, 'uncached_tokens': miss,
                  'output_tokens': out, 'tool_calls': len(toolids), 'cost_usd': cost, 'cost_basis': 'provider-list-rate',
                  'rates': price, 'time': stamp, 'seconds': time.time() - stamp, 'error': error, 'usage': usage,
                  'budget_charge_usd': cost if cost is not None else (0 if rejected else reserve),
                  'usage_missing': not valid and not rejected, 'timing': timing}
        with LOCK:
            append_durable(LEDGER, record)
            state['open'] -= 1
        write_json(state['dir'] / f'usage-{n:03}.json', record)


@contextmanager
def provider_lock():
    lock = ROOT / 'locks' / 'deepseek.lock'
    lock.parent.mkdir(parents=True, exist_ok=True)
    with lock.open('a') as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError('Another runner owns the DeepSeek provider lock') from error
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def one(task, agent, repeat, port):
    global SNAPSHOT
    rid = f'{PHASE}-{MODEL}-{task["id"]}-{agent}-r{repeat}'
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
    with LOCK:
        checked = time.time()
        b = balance()
        SNAPSHOT = {'balance': b['total_balance'], 'checked_at': checked, 'currency': b['currency']}
        pending = pending_reservations()
        if not b['is_available'] or b['total_balance'] - pending < BALANCE_FLOOR:
            raise RuntimeError(f'DeepSeek balance floor: balance {b["total_balance"]} pending {pending:.4f}')
        if phase_spend() >= SPEND_CAP:
            raise RuntimeError('Phase spend cap reached')
    d.mkdir(parents=True)
    write_json(d / 'balance-admission.json', dict(SNAPSHOT, pending_reservations=pending, method='live check before cell launch'))
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
    state = {'dir': d, 'calls': 0, 'open': 0, 'stop_reason': None}
    ACTIVE[rid] = state
    base = f'http://127.0.0.1:{port}/{rid}/v1'
    env = {k: v for k, v in os.environ.items() if not any(s in k for s in ('KEY', 'TOKEN', 'SECRET'))}
    env.update(HOME=str(home), USER='benchmark', LOGNAME='benchmark', AGENC_HOME=str(home / 'agenc'),
               PI_CODING_AGENT_DIR=str(home / 'pi'), PI_SKIP_VERSION_CHECK='1', PI_TELEMETRY='0', PI_OFFLINE='1', CI='1',
               DEEPSEEK_API_KEY='benchmark-proxy', DEEPSEEK_BASE_URL=base,
               AGENC_EFFORT_LEVEL='high', AGENC_MAX_OUTPUT_TOKENS='8192', AGENC_LIGHT_REASONING_POLICY='fixed')
    if agent == 'pi':
        compat = {'supportsDeveloperRole': False, 'supportsStore': False, 'maxTokensField': 'max_tokens',
                  'thinkingFormat': 'deepseek', 'requiresReasoningContentOnAssistantMessages': True}
        write_json(home / 'pi/models.json', {'providers': {'deepseek': {'baseUrl': base, 'api': 'openai-completions',
                   'apiKey': 'DEEPSEEK_API_KEY', 'models': [{'id': MODEL, 'reasoning': True, 'contextWindow': 1048576,
                                                            'maxTokens': 8192, 'compat': compat}]}}})
        args = [str(PI_PREFIX / 'node_modules/.bin/pi'), '--provider', 'deepseek', '--model', MODEL, '--thinking', 'high',
                '--mode', 'json', '--no-session', '-p', task['prompt']]
    else:
        trust = home / 'agenc/trusted-projects.json'
        write_json(trust, {'version': 1, 'trustedProjects': [{'path': str(repo),
                   'trustedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}]})
        trust.chmod(0o600)
        config = d / 'agenc-config.toml'
        with config.open('x', encoding='utf-8') as handle:
            handle.write(LIGHT_CONFIG)
        args = ['node', str(LIGHT_CORE / 'runtime/bin/agenc'), '-p', '--light', '--provider', 'deepseek', '--model', MODEL,
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
    # The checker runs agent-written code: a hang is a recorded failure, not a panel abort.
    try:
        check = cmd([sys.executable, str(TASKS_DIR / task['check_script']), str(repo)], timeout=120)
        check_timeout = False
    except subprocess.TimeoutExpired as expired:
        check = subprocess.CompletedProcess(expired.cmd, 124, stdout=str(expired.output or ''))
        check_timeout = True
    (d / 'check.log').write_text(check.stdout)
    deadline = time.monotonic() + 210
    while state['open'] and time.monotonic() < deadline:
        time.sleep(0.25)
    ACTIVE.pop(rid, None)
    records = [json.loads(p.read_text()) for p in sorted(d.glob('usage-*.json'))]
    budget_stop = state['stop_reason'] in ('balance_floor', 'spend_cap')
    result = {'id': rid, 'phase': PHASE, 'task': task['id'], 'category': task['category'], 'agent': agent, 'model': MODEL,
              'repeat': repeat, 'prompt_sha256': prompt_sha, 'configuration_sha256': PROVENANCE['configuration_sha256'],
              'agent_identity': PROVENANCE['agents'][agent],
              'pass': check.returncode == 0 and rc == 0 and not timeout and not budget_stop,
              'check_pass': check.returncode == 0, 'check_timeout': check_timeout, 'exit_code': rc, 'timeout': timeout,
              'budget_stop': budget_stop,
              'stop_reason': state['stop_reason'], 'wall_seconds': wall, 'load_start': load_start, 'load_end': os.getloadavg(),
              'model_calls': len(records), 'admitted_calls': state['calls'],
              'provider_errors': sum(bool(r['error']) for r in records),
              'usage_complete': len(records) == state['calls'] and all(not r['usage_missing'] for r in records)}
    for k in ('input_tokens', 'cached_tokens', 'uncached_tokens', 'output_tokens', 'tool_calls', 'cost_usd', 'budget_charge_usd'):
        result[k] = sum(r[k] for r in records if r[k] is not None)
    result['cost_basis'] = 'provider-list-rate (DeepSeek pricing.json, peak multiplier by request UTC time)'
    if not result['usage_complete']:
        result['cost_usd'] = None
    if (d / 'wire-001.json').exists():
        body = json.loads((d / 'wire-001.json').read_text())['body']
        result['first_system_chars'] = sum(len(json.dumps(m.get('content', ''))) for m in body.get('messages', [])
                                           if m.get('role') in ('system', 'developer'))
        result['first_schema_chars'] = len(json.dumps(body.get('tools', [])))
        result['sampling'] = {k: body.get(k) for k in ('model', 'thinking', 'reasoning_effort', 'max_tokens',
                                                       'max_completion_tokens', 'temperature', 'top_p')}
        result['initial_tools'] = [t.get('function', t)['name'] for t in body.get('tools', []) if 'name' in t.get('function', t)]
    if task.get('deferred_capability'):
        result['planning_evidence'] = planning_evidence(d, agent)
        result['planning_scored'] = False
    write_json(d / 'result.json', result)
    print(json.dumps({k: result[k] for k in ('id', 'pass', 'check_pass', 'exit_code', 'timeout', 'wall_seconds',
                                             'model_calls', 'cost_usd', 'usage_complete', 'stop_reason')}), flush=True)
    return result


def parser():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--root', type=pathlib.Path, required=True)
    ap.add_argument('--light-core', type=pathlib.Path, required=True)
    ap.add_argument('--light-commit', required=True)
    ap.add_argument('--pi-prefix', type=pathlib.Path, required=True)
    ap.add_argument('--phase', required=True)
    ap.add_argument('--agents', default='light,pi')
    ap.add_argument('--tasks', default='')
    ap.add_argument('--tasks-dir', type=pathlib.Path, default=HERE / 'tasks', help='Task suite directory (manifest.json + scripts)')
    ap.add_argument('--repeats', type=int, default=1)
    ap.add_argument('--repeat-start', type=int, default=1)
    ap.add_argument('--max-calls', type=int, default=45)
    ap.add_argument('--spend-cap-usd', type=float, default=1.0)
    ap.add_argument('--balance-floor-usd', type=float, default=1.0)
    ap.add_argument('--seed', type=int, default=30092026)
    ap.add_argument('--validate-only', action='store_true')
    return ap


def configure(args):
    global ROOT, LIGHT_CORE, PI_PREFIX, LEDGER, RESERVATIONS, MAX_CALLS, SPEND_CAP, BALANCE_FLOOR, PHASE, PROVENANCE, TASKS_DIR
    TASKS_DIR = args.tasks_dir.resolve()
    if sys.platform != 'linux':
        raise RuntimeError('Benchmarks must run on Linux')
    if not re.fullmatch(r'matched-[A-Za-z0-9_-]+', args.phase):
        raise ValueError('Use a matched-NAME phase')
    if args.repeats < 1 or args.repeat_start < 1 or args.max_calls < 1 or not 0 < args.spend_cap_usd <= 10 or args.balance_floor_usd < 1:
        raise ValueError('Invalid repeats, max calls, spend cap or balance floor')
    ROOT, LIGHT_CORE, PI_PREFIX = args.root.resolve(), args.light_core.resolve(), args.pi_prefix.resolve()
    LEDGER, RESERVATIONS = ROOT / 'spend-deepseek.jsonl', ROOT / 'deepseek-reservations.jsonl'
    MAX_CALLS, SPEND_CAP, BALANCE_FLOOR, PHASE = args.max_calls, args.spend_cap_usd, args.balance_floor_usd, args.phase
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
    if 'light' in agents:
        probe = cmd(['bwrap', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-all',
                     '--die-with-parent', 'true'], timeout=30)
        if probe.returncode:
            raise RuntimeError('bubblewrap cannot create its sandbox here; Light shell would be disabled: ' + probe.stdout[-300:])
    harness = sorted([*HERE.glob('*.py'), *TASKS_DIR.rglob('*.py'), TASKS_DIR / 'manifest.json', HERE / 'pricing.json'])
    PROVENANCE = {
        'schema_version': 1, 'phase': args.phase, 'model': MODEL, 'provider': 'deepseek-via-loopback-proxy',
        'harness_files_sha256': {str(p.relative_to(HERE)): sha(p.read_bytes()) for p in harness if '__pycache__' not in p.parts},
        'agents': {
            'light': {'version': version, 'dist_agenc_js_sha256': sha((LIGHT_CORE / 'runtime/dist/bin/agenc.js').read_bytes()),
                      'runtime_src_tree_sha256': tree_digest(LIGHT_CORE / 'runtime/src'),
                      'flags': ['-p', '--light', '--provider', 'deepseek', '--model', MODEL, '--config', '<per-run>',
                                '--permission-mode', 'acceptEdits', '--output-format', 'json', '--'],
                      'config_sha256': sha(LIGHT_CONFIG.encode()),
                      'sandbox': 'ordinary bubblewrap workspace-write; allow rule exec_command, write_stdin'},
            'pi': {'version': PI_VERSION, 'package_tree_sha256': tree_digest(pi_package),
                   'flags': ['--provider', 'deepseek', '--model', MODEL, '--thinking', 'high', '--mode', 'json', '--no-session', '-p'],
                   'sandbox': 'none (Pi has no sandbox)'},
        },
        'settings': {'reasoning_effort': 'high', 'output_cap': 8192, 'max_calls_per_cell': MAX_CALLS},
        'tasks': selected, 'tasks_dir': str(TASKS_DIR), 'task_manifest_sha256': sha((TASKS_DIR / 'manifest.json').read_bytes()), 'agent_set': agents, 'repeats': args.repeats, 'repeat_start': args.repeat_start, 'seed': args.seed,
        'spend_cap_usd': SPEND_CAP, 'balance_floor_usd': BALANCE_FLOOR,
        'scoring': 'code-only pass for every task and agent; task 12 planning reported, not scored',
        'pricing_sha256': sha((HERE / 'pricing.json').read_bytes()),
        'container': os.environ.get('MATCHED_CONTAINER', 'unrecorded'),
        'inherited_agent_env': sorted(k for k in os.environ if k.startswith(('AGENC_', 'PI_'))),
        'bwrap_version': cmd(['bwrap', '--version']).stdout.strip() if shutil.which('bwrap') else None,
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
    KEY = os.environ.pop('DEEPSEEK_API_KEY', '')
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
            raise RuntimeError('Missing DeepSeek process credential')
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Proxy)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            for task, agent, repeat in jobs:
                one(task, agent, repeat, server.server_port)
        finally:
            server.shutdown()
            KEY = ''


if __name__ == '__main__':
    main()
