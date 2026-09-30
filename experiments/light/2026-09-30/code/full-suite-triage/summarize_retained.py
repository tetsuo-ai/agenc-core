"""Read retained logs; emit failure categories/source references, never log bodies."""
import collections
import hashlib
import json
import pathlib
import re

ROOT = pathlib.Path('/home/paul/claude-agenc-work/results')


def classify(file, block):
    if 'timed out waiting for failpoint marker' in block:
        return 'failpoint_marker_timeout_20s'
    if 'fresh daemon did not become SDK-ready' in block:
        return 'daemon_readiness_timeout_20s'
    if 'Test timed out in' in block:
        return 'test_timeout'
    if any(x in block for x in ['detected dubious ownership', 'Hermetic tests require a Git checkout']):
        return 'git_checkout_authority_mismatch'
    if file == 'tests/plugins/plugin-settings.test.ts':
        return 'pattern_validation_or_dependent_assertion'
    if file in ['tests/prompts/agenc-md.test.ts', 'tests/session/runtime-options.test.ts', 'tests/state/recovery-mutations.test.ts']:
        return 'posix_permission_fixture_assertion'
    if file == 'tests/session/session-fd-leaks.test.ts':
        return 'descriptor_baseline_assertion'
    if file.startswith('tests/tui/') or file == 'tests/commands/workflow-permissions.test.tsx':
        return 'ui_observation_assertion'
    if 'timed out' in block:
        return 'child_process_deadline'
    if 'ENOENT' in block:
        return 'missing_child_marker'
    return 'other_assertion_or_contract'


def failures(path):
    raw = path.read_bytes()
    lines = raw.decode().splitlines()
    starts = [i for i, line in enumerate(lines) if re.match(r'\s*FAIL\s+tests/', line)]
    result = {}
    for idx, begin in enumerate(starts):
        end = starts[idx+1] if idx+1 < len(starts) else len(lines)
        block = '\n'.join(lines[begin+1:end])
        identity = lines[begin].strip()
        file = identity.split(' > ')[0].split(None, 1)[1]
        refs = re.findall(r'(?:tests|src|scripts)/[^\s:]+:\d+(?::\d+)?', block)
        result[identity] = {'file': file, 'log_line': begin+1,
            'identity_sha256': hashlib.sha256(identity.encode()).hexdigest(),
            'category': classify(file, block), 'source_refs': list(dict.fromkeys(refs))[:4]}
    summaries = [line.strip() for line in lines if re.match(r'\s*(Test Files |Tests |Duration |exit=)', line)]
    return result, {'file': path.name, 'sha256': hashlib.sha256(raw).hexdigest(),
                    'provenance': lines[0], 'summary': summaries}


def main():
    baseline, base_log = failures(ROOT/'light-runtime-main.log')
    candidate, candidate_log = failures(ROOT/'light-runtime-r3-full.log')
    by_file = collections.defaultdict(list)
    for identity, row in candidate.items():
        row['also_fails_baseline'] = identity in baseline
        if identity in baseline:
            row['baseline_log_line'] = baseline[identity]['log_line']
            row['baseline_category'] = baseline[identity]['category']
        by_file[row['file']].append(row)
    retained = []
    for label in ['focus'] + [f'alone-{n:02}' for n in range(1, 9)]:
        _, meta = failures(ROOT/f'light-runtime-r3-{label}.log')
        retained.append(meta)
    print(json.dumps({'baseline': base_log, 'candidate': candidate_log,
        'counts': {'baseline_failed': len(baseline), 'candidate_failed': len(candidate),
                   'shared_identity': len(baseline.keys() & candidate.keys()),
                   'candidate_only': len(candidate.keys() - baseline.keys()),
                   'baseline_only': len(baseline.keys() - candidate.keys())},
        'categories': dict(collections.Counter(r['category'] for r in candidate.values())),
        'files': dict(by_file), 'focused_and_isolated': retained}, indent=2))


if __name__ == '__main__':
    main()
