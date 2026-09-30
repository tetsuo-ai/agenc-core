"""Offline-reviewed proposal. No CLI, provider access, or approved live guard hashes.

Only an explicitly authorized operator may call acknowledge_presend_stop.
Trusted, quiescent local directory and cooperative provider-flock users required.
Tests temporarily allowlist their synthetic guard; live sources are NOT approved.
"""
import fcntl
import hashlib
import json
import math
import os
import pathlib
import re
import stat

REVIEWED_PRESEND_GUARDS = frozenset()
REVIEWED_FIX_VALIDATIONS = {}
REASON = 'unexpected_model_settings'


class Refusal(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise Refusal(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def regular_bytes(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        require(stat.S_ISREG(os.fstat(fd).st_mode), 'expected regular evidence file')
        with os.fdopen(os.dup(fd), 'rb') as stream:
            return stream.read()
    finally:
        os.close(fd)


def journal_snapshot(root, reviewed_aliases):
    """Only the exact receipt-reviewed historical DeepSeek alias is supported."""
    permitted = {'spend-deepseek.jsonl': 'spend-converged-guard-v2.jsonl'}
    require(type(reviewed_aliases) is dict and reviewed_aliases in ({}, permitted),
            'unsupported reviewed journal alias mapping')
    paths = set(root.glob('*.jsonl'))
    observed = {p.name for p in paths if stat.S_ISLNK(p.lstat().st_mode)}
    require(observed == set(reviewed_aliases), 'journal aliases do not match reviewed mapping')
    captured = {}
    for path in sorted(paths):
        before = path.lstat()
        target = path
        metadata = {}
        if path.name in reviewed_aliases:
            link_text = os.readlink(path)
            require(link_text == reviewed_aliases[path.name], 'journal alias target changed')
            target = root / link_text
            metadata = {'alias_device': before.st_dev, 'alias_inode': before.st_ino,
                        'link_text': link_text}
        fd = os.open(target, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            target_stat = os.fstat(fd)
            require(stat.S_ISREG(target_stat.st_mode), 'expected regular journal target')
            with os.fdopen(os.dup(fd), 'rb') as stream:
                raw = stream.read()
            current_target = target.lstat()
            require((current_target.st_dev, current_target.st_ino) ==
                    (target_stat.st_dev, target_stat.st_ino), 'journal target changed during snapshot')
        finally:
            os.close(fd)
        after = path.lstat()
        require((before.st_dev, before.st_ino) == (after.st_dev, after.st_ino),
                'journal identity changed during snapshot')
        if metadata:
            require(os.readlink(path) == metadata['link_text'], 'journal alias changed during snapshot')
        captured[path.name] = {**metadata, 'target_device': target_stat.st_dev,
                               'target_inode': target_stat.st_ino, 'sha256': digest(raw)}
    return captured


def directory(path):
    require(stat.S_ISDIR(path.lstat().st_mode), 'expected real directory')


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        require(stat.S_ISDIR(os.fstat(fd).st_mode), 'expected directory descriptor')
        os.fsync(fd)
    finally:
        os.close(fd)


def write_new(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(os.dup(fd), 'wb') as stream:
            stream.write(data)
            stream.flush()
        os.fsync(fd)
    finally:
        os.close(fd)
    sync_directory(path.parent)


def encoded(value):
    return (json.dumps(value, sort_keys=True, indent=2) + '\n').encode()


def number(value):
    return type(value) in (int, float) and math.isfinite(value) and value >= 0


def complete_usage(record):
    usage = record.get('usage')
    if not isinstance(usage, dict):
        return False
    details = usage.get('input_tokens_details', {})
    if not isinstance(details, dict):
        return False
    cached = details.get('cached_tokens', 0)
    fields = ('input_tokens', 'output_tokens', 'cached_tokens', 'uncached_tokens')
    return (record.get('usage_missing') is False and 'error' in record and record['error'] is None
            and isinstance(usage, dict)
            and all(type(usage.get(k)) is int and usage[k] >= 0 for k in ('input_tokens', 'output_tokens'))
            and all(type(record.get(k)) is int and record[k] >= 0 for k in fields)
            and type(cached) is int and 0 <= cached <= usage['input_tokens']
            and record['input_tokens'] == usage['input_tokens']
            and record['output_tokens'] == usage['output_tokens']
            and record['cached_tokens'] == cached
            and record['uncached_tokens'] == usage['input_tokens'] - cached
            and number(record.get('cost_usd')) and number(record.get('budget_charge_usd'))
            and record['cost_usd'] == record['budget_charge_usd'])


def verify_response(wire, raw, usage):
    body = wire.get('body')
    require(isinstance(body, dict) and body.get('model') == 'gpt-6-luna'
            and body.get('reasoning', {}).get('effort') == 'low'
            and type(body.get('max_output_tokens')) is int and body['max_output_tokens'] == 8192,
            'admitted wire settings are not the fixed contract')
    if body.get('stream') is True:
        completed = []
        for line in raw.decode().splitlines():
            if not line.startswith('data:'):
                continue
            payload = line[5:].strip()
            if payload == '[DONE]':
                continue
            event = json.loads(payload)
            require(isinstance(event, dict), 'invalid SSE event')
            response = event.get('response', {})
            require(event.get('type') not in ('error', 'response.failed', 'response.incomplete', 'response.cancelled')
                    and event.get('error') is None and isinstance(response, dict)
                    and response.get('error') is None
                    and response.get('status') not in ('failed', 'incomplete', 'cancelled'),
                    'recorded upstream error or incomplete response')
            if event.get('type') == 'response.completed':
                completed.append(response)
        require(len(completed) == 1, 'missing or ambiguous completed response')
        response = completed[0]
    else:
        response = json.loads(raw)
    require(isinstance(response, dict) and response.get('status') == 'completed'
            and response.get('error') is None and response.get('usage') == usage,
            'terminal response and usage disagree')


def acknowledge_presend_stop(root, *, expected_stop_sha256, expected_run,
                            fix_sha, fresh_phase, authority_id, reviewed_guard_path,
                            fix_validation_path,
                            expected_fresh_provenance_sha256,
                            explicitly_authorized=False):
    """Acknowledge ONE reviewed pre-send settings stop; never resume/run a phase.

    No production guard is currently allowlisted. Expected values must be supplied
    by an operator after reviewing fixed-policy evidence and granting this exact
    acknowledgement. A fix SHA is provenance, not proof its tests passed.
    """
    require(explicitly_authorized is True, 'explicit operator acknowledgement required')
    require(re.fullmatch(r'[0-9a-f]{64}', expected_stop_sha256 or ''), 'invalid expected stop hash')
    require(re.fullmatch(r'[0-9a-f]{40}', fix_sha or ''), 'invalid fix SHA')
    for value in (expected_run, fresh_phase, authority_id):
        require(isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_-]{1,240}', value), 'invalid identity')
    root = pathlib.Path(root)
    directory(root)
    locks = root / 'locks'
    directory(locks)
    lock_fd = os.open(locks / 'openai.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        require(stat.S_ISREG(os.fstat(lock_fd).st_mode), 'invalid provider lock')
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise Refusal('provider runner is active') from error
        return _locked(root, expected_stop_sha256, expected_run, fix_sha,
                       fresh_phase, authority_id, pathlib.Path(reviewed_guard_path),
                       pathlib.Path(fix_validation_path), expected_fresh_provenance_sha256)
    finally:
        os.close(lock_fd)


def _locked(root, expected_hash, run, fix, phase, authority, guard_path, fix_validation_path, fresh_provenance_hash):
    stop = root / 'luna-api-stop.json'
    resolution_root = root / 'stop-resolutions'
    folder = resolution_root / expected_hash
    expected = {'stop_sha256': expected_hash, 'run': run, 'fix_sha': fix,
                'fresh_phase': phase, 'authority_id': authority,
                'fresh_provenance_sha256': fresh_provenance_hash}
    require(not os.path.lexists(root / 'luna-api-admission.lock'), 'active admission lock')
    if not os.path.lexists(stop):
        directory(resolution_root)
        directory(folder)
        done = json.loads(regular_bytes(folder / 'completed.json'))
        require(all(done.get(k) == v for k, v in expected.items()), 'resolution identity mismatch')
        require(done.get('status') == 'acknowledged_presend_only', 'resolution incomplete')
        require(digest(regular_bytes(folder / 'original-stop.json')) == expected_hash, 'archive mismatch')
        require(digest(regular_bytes(folder / 'retired-stop.json')) == expected_hash, 'retired marker mismatch')
        return {'status': 'already_acknowledged', **expected}
    original = regular_bytes(stop)
    require(digest(original) == expected_hash, 'active stop hash mismatch')
    stop_stat = stop.lstat()
    stop_record = json.loads(original)
    require(stop_record.get('run') == run and stop_record.get('reason') == REASON, 'not the expected pre-send settings stop')
    require(set(stop_record) <= {'run', 'reason', 'time', 'settings'}, 'unknown stop record fields')
    guard_hash = digest(regular_bytes(guard_path))
    require(guard_hash in REVIEWED_PRESEND_GUARDS, 'historical guard has no reviewed pre-send proof')
    fix_validation = regular_bytes(fix_validation_path)
    require(REVIEWED_FIX_VALIDATIONS.get(fix) == digest(fix_validation), 'fix validation is not reviewed')
    validation = json.loads(fix_validation)
    require(validation.get('fix_sha') == fix and validation.get('fixed_policy_validated') is True
            and validation.get('provider_calls') == 0, 'fixed policy validation mismatch')
    require(validation.get('fresh_phase') == phase
            and validation.get('fresh_provenance_sha256') == fresh_provenance_hash,
            'reviewed fix receipt phase or preflight hash mismatch')
    reviewed_aliases = validation.get('reviewed_journal_aliases', {})

    runs = root / 'runs'
    directory(runs)
    run_dir = runs / run
    directory(run_dir)
    result_path = run_dir / 'result.json'
    snapshots = {result_path: regular_bytes(result_path)}
    result = json.loads(snapshots[result_path])
    require(result.get('id') == run and result.get('provider') == 'openai', 'run identity mismatch')
    require(result.get('model') == 'gpt-6-luna', 'unexpected run model')
    old_phase = result.get('phase')
    require(isinstance(old_phase, str) and run.startswith(old_phase + '-')
            and old_phase != phase and not run.startswith(phase + '-'), 'fresh distinct phase required')
    require(not any(p.name.startswith(phase + '-') for p in runs.iterdir()), 'proposed phase already attempted')
    fresh_provenance = root / f'provenance-{phase}-openai.json'
    if os.path.lexists(fresh_provenance):
        require(isinstance(fresh_provenance_hash, str) and re.fullmatch(r'[0-9a-f]{64}', fresh_provenance_hash),
                'existing preflight needs exact expected provenance hash')
        snapshots[fresh_provenance] = regular_bytes(fresh_provenance)
        require(digest(snapshots[fresh_provenance]) == fresh_provenance_hash, 'fresh preflight hash mismatch')
        preflight = json.loads(snapshots[fresh_provenance])
        settings = preflight.get('reasoning_settings_by_agent', {}).get('light', {})
        require(preflight.get('candidate_revision') == fix and preflight.get('phase') == phase
                and preflight.get('provider') == 'openai'
                and preflight.get('light_adaptive_effort') is False and preflight.get('light_adaptive_high') is False
                and preflight.get('reasoning_effort') == 'low' and preflight.get('output_cap') == 8192
                and settings.get('light_reasoning_policy') == 'fixed'
                and settings.get('reasoning_effort') == 'low'
                and isinstance(preflight.get('configuration_sha256'), str)
                and preflight['configuration_sha256'] == validation.get('configuration_sha256'),
                'fresh preflight does not bind the reviewed fixed configuration')
    else:
        raise Refusal('reviewed fresh preflight is required before acknowledgement')
    require(result.get('agent_revision') != fix, 'fix revision must differ from stopped candidate')
    require(result.get('budget_stop') is True and result.get('stop_reason') == REASON
            and result.get('usage_complete') is True and type(result.get('provider_errors')) is int
            and result['provider_errors'] == 0
            and result.get('timeout') is False and result.get('pass') is False, 'run outcome is ambiguous')
    recorded_guard = result.get('provenance', {}).get('harness_files_sha256', {}).get('direct.mjs')
    require(recorded_guard == guard_hash, 'historical guard provenance mismatch')

    ledger_path = root / 'luna-api-ledger.jsonl'
    snapshots[ledger_path] = regular_bytes(ledger_path)
    # Preserve every existing root JSONL journal, including spend-luna,
    # spend-deepseek and historical reservation journals, byte for byte.
    journals = journal_snapshot(root, reviewed_aliases)
    rows = [json.loads(line) for line in snapshots[ledger_path].splitlines() if line.strip()]
    admitted, settled = {}, {}
    for row in rows:
        require(row.get('event') in ('admit', 'settle'), 'unknown ledger event')
        target = admitted if row['event'] == 'admit' else settled
        identity = row.get('id')
        require(isinstance(identity, str) and identity not in target, 'duplicate or missing ledger identity')
        require(not str(row.get('run', '')).startswith(phase + '-'), 'proposed phase already admitted')
        target[identity] = row
    calls = {key: row for key, row in admitted.items() if row.get('run') == run}
    require(type(result.get('model_calls')) is int and result['model_calls'] == len(calls), 'call count mismatch')
    require({key for key, row in settled.items() if row.get('run') == run} == set(calls), 'stopped run is not fully settled')
    require(sorted(row.get('call') for row in calls.values()) == list(range(1, len(calls)+1)), 'noncontiguous stopped-run calls')
    totals = {key: 0 for key in ('input_tokens', 'output_tokens', 'cached_tokens', 'uncached_tokens', 'cost_usd', 'budget_charge_usd')}
    for identity, admission in sorted(calls.items(), key=lambda item: item[1]['call']):
        settlement = settled[identity]
        n = admission['call']
        require(identity == f'{run}:{n}' and settlement.get('call') == n and settlement.get('run') == run,
                'settlement identity mismatch')
        require(complete_usage(settlement), 'stopped run has unknown usage, error or hold')
        usage_path = run_dir / f'usage-{n:03}.json'
        snapshots[usage_path] = regular_bytes(usage_path)
        usage = json.loads(snapshots[usage_path])
        require(complete_usage(usage), 'usage artifact incomplete')
        require(all(usage.get(k) == settlement.get(k) for k in
                    ('run', 'call', 'usage', 'usage_missing', 'error', *totals)),
                'usage and settlement disagree')
        for key in totals:
            totals[key] += usage[key]
        wire_path = run_dir / f'wire-{n:03}.json'
        response_path = run_dir / f'response-{n:03}.txt'
        snapshots[wire_path] = regular_bytes(wire_path)
        snapshots[response_path] = regular_bytes(response_path)
        verify_response(json.loads(snapshots[wire_path]), snapshots[response_path], usage['usage'])
    require(all(type(result.get(key)) is int and result[key] == totals[key]
                for key in ('input_tokens', 'output_tokens', 'cached_tokens', 'uncached_tokens'))
            and all(number(result.get(key)) and result[key] == totals[key]
                    for key in ('cost_usd', 'budget_charge_usd')), 'result totals disagree')
    for pattern in ('usage-*.json', 'wire-*.json', 'response-*.txt'):
        for item in run_dir.glob(pattern):
            match = re.fullmatch(r'(usage|wire|response)-(\d+)\.(json|txt)', item.name)
            require(match and 1 <= int(match[2]) <= len(calls), 'unadmitted run artifact')

    require(not os.path.lexists(folder), 'partial or existing resolution requires review')
    admission_lock = root / 'luna-api-admission.lock'
    admission_lock.mkdir(mode=0o700)  # Same atomic exclusion used by direct.mjs.
    owner_stat = admission_lock.lstat()
    owner = {'operation': 'explicit_presend_stop_acknowledgement', **expected,
             'device': owner_stat.st_dev, 'inode': owner_stat.st_ino}
    owner_bytes = encoded(owner)
    owner_path = admission_lock / 'acknowledgement-owner.json'
    write_new(owner_path, owner_bytes)
    sync_directory(root)
    # Keep this directory on EVERY exceptional exit after acquisition. It is a
    # crash-persistent admission barrier, not a stale lock to remove on retry.
    require(journal_snapshot(root, reviewed_aliases) == journals
            and all(regular_bytes(p) == raw for p, raw in snapshots.items()), 'evidence changed under admission lock')
    require(regular_bytes(stop) == original, 'stop changed under admission lock')
    if not os.path.lexists(resolution_root):
        resolution_root.mkdir(mode=0o700)
        sync_directory(root)
    directory(resolution_root)
    folder.mkdir(mode=0o700)
    sync_directory(resolution_root)
    write_new(folder / 'original-stop.json', original)
    evidence = {**expected, 'status': 'prepared_presend_acknowledgement',
                'historical_guard_sha256': guard_hash, 'settled_stopped_run_calls': len(calls),
                'fix_validation_sha256': digest(fix_validation), 'admission_lock_owner': owner,
                'reviewed_journal_aliases': reviewed_aliases, 'journal_snapshots': journals,
                'historical_other_unsettled_reservations': sum(
                    key not in settled and row.get('run') != run for key, row in admitted.items()),
                'evidence_sha256': {str(p.relative_to(root)): digest(raw) for p, raw in snapshots.items()},
                'old_phase_unchanged': True, 'provider_calls': 0}
    write_new(folder / 'prepared.json', encoded(evidence))
    current_lock = admission_lock.lstat()
    require((current_lock.st_dev, current_lock.st_ino) == (owner_stat.st_dev, owner_stat.st_ino)
            and regular_bytes(owner_path) == owner_bytes, 'admission lock ownership changed')
    require(journal_snapshot(root, reviewed_aliases) == journals
            and all(regular_bytes(p) == raw for p, raw in snapshots.items()), 'evidence changed under lock')
    current = stop.lstat()
    require((current.st_dev, current.st_ino) == (stop_stat.st_dev, stop_stat.st_ino)
            and regular_bytes(stop) == original, 'active stop changed before acknowledgement')
    retired = folder / 'retired-stop.json'
    moved = False
    try:
        os.rename(stop, retired)
        moved = True
        moved_stat = retired.lstat()
        require((moved_stat.st_dev, moved_stat.st_ino) == (stop_stat.st_dev, stop_stat.st_ino)
                and regular_bytes(retired) == original, 'stop changed at rename boundary')
        sync_directory(folder)
        sync_directory(root)
        evidence['status'] = 'acknowledged_presend_only'
        write_new(folder / 'completed.json', encoded(evidence))
    except BaseException:
        if moved:
            # Restore only the actually moved marker; never overwrite a newer one.
            try:
                os.link(retired, stop, follow_symlinks=False)
                sync_directory(root)
            except FileExistsError:
                pass
        raise
    require(not os.path.lexists(stop), 'newer stop appeared; admission remains blocked')
    require(journal_snapshot(root, reviewed_aliases) == journals
            and all(regular_bytes(p) == raw for p, raw in snapshots.items()), 'evidence changed before release')
    current_lock = admission_lock.lstat()
    require((current_lock.st_dev, current_lock.st_ino) == (owner_stat.st_dev, owner_stat.st_ino)
            and regular_bytes(owner_path) == owner_bytes
            and sorted(p.name for p in admission_lock.iterdir()) == ['acknowledgement-owner.json'],
            'admission lock ownership changed before release')
    owner_path.unlink()
    admission_lock.rmdir()
    sync_directory(root)
    return {'status': 'acknowledged_presend_only', **expected}
