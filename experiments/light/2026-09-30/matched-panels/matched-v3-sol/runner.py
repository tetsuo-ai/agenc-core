#!/usr/bin/env python3
"""Matched AgenC Light vs Pi panel on GPT-5.6 Sol via the ChatGPT subscription (matched-v3-sol).

Same cell contract as matched-v3 (Luna): Light keeps AgenC's ordinary sandbox
(bubblewrap, acceptEdits, allow rule for exec_command/write_stdin, no bypass),
startup flags precede `--` and the prompt, one pinned Linux Core build, task 12
scored code-only for both agents, adjacent matched pairs in seeded order, one
cell at a time.

Provider access: a loopback proxy in this process forwards each Responses call
to the owner's ChatGPT-subscription proxy on the Mac (which holds the OAuth
token and rewrites bodies for the ChatGPT backend). Agents only see a dummy key
and a per-run base URL; this process only holds the Mac proxy's local secret.
Subscription use is unpriced: usage tokens are recorded per call in
spend-sol.jsonl, cost is null. The Mac proxy health endpoint is checked before
every cell and a rate limit stops the panel. Linux only.
"""
import argparse, datetime, fcntl, hashlib, http.server, json, os, pathlib, random, re, shutil, signal, subprocess, sys, threading, time, urllib.error, urllib.request
from contextlib import contextmanager
from trace_checks import planning_evidence

HERE = pathlib.Path(__file__).resolve().parent
TASKS_DIR = HERE / 'tasks'
PI_VERSION = '0.73.1'
MODEL = 'gpt-5.6-sol'
UPSTREAM = 'http://192.168.1.206:8799/v1'
LIGHT_CONFIG = ('config_version = 2\nmodel = "gpt-5.6-sol"\nmodel_provider = "openai"\nreasoning_effort = "low"\n'
                'reasoning_summary = "auto"\nlight_reasoning_policy = "fixed"\nmax_output_tokens = 8192\n'
                # Ordinary allow rule, not a bypass (see matched-v2): commands still run in the
                # OS sandbox; escalation requests still need an approver (none headless).
                '\n[permissions]\nallow = ["exec_command", "write_stdin"]\n')
KEY = ''
ROOT = LIGHT_CORE = PI_PREFIX = LEDGER = None
MAX_CALLS = 45
PHASE = ''
PROVENANCE = {}
LOCK = threading.Lock()
ACTIVE = {}


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
            if state['calls'] >= MAX_CALLS:
                state['stop_reason'] = 'call_limit'
                self.send_error(429, 'Per-cell call limit')
                return
            state['calls'] += 1
            n = state['calls']
            state['open'] += 1
        write_json(state['dir'] / f'wire-{n:03}.json', {'sent_at': stamp, 'body': body})
        req = urllib.request.Request(UPSTREAM + '/responses', data=json.dumps(body).encode(),
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
                        kind = event.get('type', '')
                        if timing['first_token_at'] is None and kind.endswith('.delta'):
                            timing['first_token_at'] = time.time()
                        if event.get('response', {}).get('usage'):
                            usage = event['response']['usage']
                        if event.get('item', {}).get('type') == 'function_call':
                            toolids.add(event['item'].get('call_id', event['item'].get('id')))
                        if kind in ('error', 'response.failed', 'response.incomplete'):
                            error = {'type': 'upstream_event', 'event_type': kind}
                timing['stream_end_at'] = time.time()
                raw = b''.join(chunks)
                if not body.get('stream'):
                    event = json.loads(raw)
                    usage = event.get('usage', {})
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
        inp, out = usage.get('input_tokens', 0), usage.get('output_tokens', 0)
        hit = (usage.get('input_tokens_details') or {}).get('cached_tokens', 0)
        # Usage counts only when the required counters are present, finite and consistent.
        valid = (isinstance(usage.get('input_tokens'), int) and isinstance(usage.get('output_tokens'), int)
                 and inp > 0 and out >= 0 and 0 <= hit <= inp)
        rejected = bool(error and 400 <= error.get('status', 0) < 500)
        if error and error.get('status') == 429:
            state['stop_reason'] = 'rate_limited'
        record = {'run': rid, 'call': n, 'model': MODEL, 'input_tokens': inp, 'cached_tokens': hit, 'uncached_tokens': inp - hit,
                  'output_tokens': out, 'tool_calls': len(toolids), 'cost_usd': None,
                  'cost_basis': 'subscription-unpriced (ChatGPT OAuth)', 'time': stamp, 'seconds': time.time() - stamp,
                  'error': error, 'usage': usage, 'budget_charge_usd': 0,
                  'usage_missing': not valid and not rejected, 'timing': timing}
        with LOCK:
            append_durable(LEDGER, record)
            state['open'] -= 1
        write_json(state['dir'] / f'usage-{n:03}.json', record)


@contextmanager
def provider_lock():
    lock = ROOT / 'locks' / 'chatgpt-sol.lock'
    lock.parent.mkdir(parents=True, exist_ok=True)
    with lock.open('a') as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError('Another runner owns the ChatGPT Sol provider lock') from error
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
    health = urllib.request.Request(UPSTREAM + '/proxy-health', headers={'Authorization': 'Bearer ' + KEY})
    try:
        with urllib.request.urlopen(health, timeout=15) as res:
            healthy = res.status == 200
    except urllib.error.URLError:
        healthy = False
    if not healthy:
        raise RuntimeError('Mac ChatGPT proxy unhealthy or rate limited; stop before launching ' + rid)
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
    state = {'dir': d, 'calls': 0, 'open': 0, 'stop_reason': None}
    ACTIVE[rid] = state
    base = f'http://127.0.0.1:{port}/{rid}/v1'
    env = {k: v for k, v in os.environ.items() if not any(s in k for s in ('KEY', 'TOKEN', 'SECRET'))}
    env.update(HOME=str(home), USER='benchmark', LOGNAME='benchmark', AGENC_HOME=str(home / 'agenc'),
               PI_CODING_AGENT_DIR=str(home / 'pi'), PI_SKIP_VERSION_CHECK='1', PI_TELEMETRY='0', PI_OFFLINE='1', CI='1',
               OPENAI_API_KEY='benchmark-proxy', OPENAI_BASE_URL=base,
               # Light product defaults on OpenAI, stated explicitly: replay on, session-tail cache off.
               AGENC_EFFORT_LEVEL='low', AGENC_MAX_OUTPUT_TOKENS='8192', AGENC_OPENAI_REASONING_REPLAY='1',
               AGENC_CACHE_SESSION_TAIL='0', AGENC_LIGHT_REASONING_POLICY='fixed')
    if agent == 'pi':
        write_json(home / 'pi/models.json', {'providers': {'openai': {'baseUrl': base, 'api': 'openai-responses',
                   'apiKey': 'OPENAI_API_KEY', 'models': [{'id': MODEL, 'reasoning': True, 'contextWindow': 1050000,
                                                          'maxTokens': 8192, 'compat': {}}]}}})
        args = [str(PI_PREFIX / 'node_modules/.bin/pi'), '--provider', 'openai', '--model', MODEL, '--thinking', 'low',
                '--mode', 'json', '--no-session', '-p', task['prompt']]
    else:
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
    budget_stop = state['stop_reason'] == 'rate_limited'
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
    result['cost_basis'] = 'subscription-unpriced (ChatGPT OAuth)'
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
    ap.add_argument('--repeats', type=int, default=1)
    ap.add_argument('--repeat-start', type=int, default=1)
    ap.add_argument('--max-calls', type=int, default=45)
    ap.add_argument('--seed', type=int, default=30092026)
    ap.add_argument('--validate-only', action='store_true')
    return ap


def configure(args):
    global ROOT, LIGHT_CORE, PI_PREFIX, LEDGER, MAX_CALLS, PHASE, PROVENANCE
    if sys.platform != 'linux':
        raise RuntimeError('Benchmarks must run on Linux')
    if not re.fullmatch(r'matched-[A-Za-z0-9_-]+', args.phase):
        raise ValueError('Use a matched-NAME phase')
    if args.repeats < 1 or args.repeat_start < 1 or args.max_calls < 1:
        raise ValueError('Invalid repeats or max calls')
    ROOT, LIGHT_CORE, PI_PREFIX = args.root.resolve(), args.light_core.resolve(), args.pi_prefix.resolve()
    LEDGER = ROOT / 'spend-sol.jsonl'
    MAX_CALLS, PHASE = args.max_calls, args.phase
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
    harness = sorted([*HERE.glob('*.py'), *TASKS_DIR.rglob('*.py'), TASKS_DIR / 'manifest.json'])
    PROVENANCE = {
        'schema_version': 1, 'phase': args.phase, 'model': MODEL, 'provider': 'chatgpt-subscription-via-mac-proxy',
        'harness_files_sha256': {str(p.relative_to(HERE)): sha(p.read_bytes()) for p in harness if '__pycache__' not in p.parts},
        'agents': {
            'light': {'version': version, 'dist_agenc_js_sha256': sha((LIGHT_CORE / 'runtime/dist/bin/agenc.js').read_bytes()),
                      'runtime_src_tree_sha256': tree_digest(LIGHT_CORE / 'runtime/src'),
                      'flags': ['-p', '--light', '--provider', 'openai', '--model', MODEL, '--config', '<per-run>',
                                '--permission-mode', 'acceptEdits', '--output-format', 'json', '--'],
                      'config_sha256': sha(LIGHT_CONFIG.encode()),
                      'sandbox': 'ordinary bubblewrap workspace-write; allow rule exec_command, write_stdin'},
            'pi': {'version': PI_VERSION, 'package_tree_sha256': tree_digest(pi_package),
                   'flags': ['--provider', 'openai', '--model', MODEL, '--thinking', 'low', '--mode', 'json', '--no-session', '-p'],
                   'sandbox': 'none (Pi has no sandbox)'},
        },
        'settings': {'reasoning_effort': 'low', 'reasoning_summary': 'auto', 'output_cap': 'dropped by the ChatGPT backend proxy for both agents',
                     'max_calls_per_cell': MAX_CALLS, 'upstream': UPSTREAM},
        'tasks': selected, 'agent_set': agents, 'repeats': args.repeats, 'repeat_start': args.repeat_start, 'seed': args.seed,
        'scoring': 'code-only pass for every task and agent; task 12 planning reported, not scored',
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
    KEY = os.environ.pop('SOL_PROXY_SECRET', '')
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
            raise RuntimeError('Missing Mac proxy secret')
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
