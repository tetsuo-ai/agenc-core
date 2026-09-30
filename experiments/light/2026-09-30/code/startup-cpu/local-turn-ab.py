#!/usr/bin/env python3
"""Paired lazy-local-turn split experiment using the byte-pinned offline fixture.

No quality scores or provider calls. Existing v3 evidence is read-only.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import platform
import subprocess
import threading
from types import SimpleNamespace

PINS = {
    'control': '09506769e70269d451716d64ffa02fa4917e993e',
    'treatment': 'aaf332b45d0ec7b2f6f7b6e223b5648c8bab2d6d',
}
FIXTURE_PINS = {
    'run.py': 'fd30b5e55fc126fa07daaf44ec4963727ce8d537573b5c6d29588f79f6147a3e',
    'transport.mjs': 'c89d853a75ed765e4556cad245e956e005af9383ae5f8f195c883ec16cbae8dd',
}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


class BlockingWaitPopen(subprocess.Popen):
    """Use waitpid's blocking wait, not Python's timed-wait polling ladder."""
    def wait(self, timeout=None):
        if timeout is None:
            return super().wait()
        expired = threading.Event()
        def expire():
            expired.set()
            self.kill()  # Only the owned child; Popen guards PID reuse.
        watchdog = threading.Timer(timeout, expire)
        watchdog.daemon = True
        watchdog.start()
        try:
            code = super().wait()
        finally:
            watchdog.cancel()
            watchdog.join()
        if expired.is_set():
            raise subprocess.TimeoutExpired(self.args, timeout)
        return code


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--control', type=Path, required=True)
    ap.add_argument('--treatment', type=Path, required=True)
    ap.add_argument('--fixture', type=Path, required=True)
    ap.add_argument('--output', type=Path, required=True)
    args = ap.parse_args()
    if platform.system() != 'Linux' or any(Path('/sys/class/net').glob('eth*')):
        raise SystemExit('Requires Linux network-disabled container')
    for name, expected in FIXTURE_PINS.items():
        if digest(args.fixture/name) != expected:
            raise SystemExit('Fixture digest mismatch: '+name)
    provenance = {'sources': {}, 'fixture': FIXTURE_PINS,
                  'runner_sha256': digest(Path(__file__)),
                  'scope': 'instrumented_one_synthetic_response_not_task_quality',
                  'repeats': 5, 'network': 'none',
                  'parent_wait': 'blocking_waitpid_with_owned_child_watchdog'}
    for arm, expected in PINS.items():
        core = getattr(args, arm)
        revision = subprocess.check_output(['git', '-C', str(core), 'rev-parse', 'HEAD'], text=True).strip()
        dirty = subprocess.check_output(['git', '-C', str(core), 'status', '--porcelain'], text=True)
        if revision != expected or dirty:
            raise SystemExit('Source identity/cleanliness failed: '+arm)
        # Bind all emitted runtime files, not just a launcher pointing elsewhere.
        artifacts = [core/'runtime/bin/agenc'] + sorted(p for p in (core/'runtime/dist').rglob('*') if p.is_file())
        provenance['sources'][arm] = {'commit': revision, 'build_files': {
            str(p.relative_to(core)): digest(p) for p in artifacts}}
    spec = importlib.util.spec_from_file_location('pinned_boundary', args.fixture/'run.py')
    fixture = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fixture)
    # Override only the diagnostic CLI wait, not subprocess.run cleanup or
    # global subprocess behavior. v1 results preserve the original polling.
    fixture.subprocess = SimpleNamespace(Popen=BlockingWaitPopen,
        TimeoutExpired=subprocess.TimeoutExpired, run=subprocess.run,
        STDOUT=subprocess.STDOUT)
    args.output.mkdir(mode=0o700, exist_ok=False)
    for arm in PINS:
        (args.output/arm).mkdir(mode=0o700)
    fixture.write(args.output/'provenance.json', provenance)
    results = []
    for repeat in range(1, 6):
        for arm in (('control', 'treatment') if repeat % 2 else ('treatment', 'control')):
            result = fixture.measure(SimpleNamespace(core=getattr(args, arm), output=args.output/arm), 'light', repeat)
            request = next(row for row in result['records_before_cleanup'] if row['stage'] == 'request_received')
            if request.get('summary') != 'auto' or request.get('replay_requested') is not True:
                raise RuntimeError('Unexpected summary/replay settings; stop without continuing')
            results.append({'variant': arm, **result})
    fixture.write(args.output/'summary.json', results)
    print(json.dumps({'completed_samples': len(results), 'sources': PINS}), flush=True)


if __name__ == '__main__':
    main()
