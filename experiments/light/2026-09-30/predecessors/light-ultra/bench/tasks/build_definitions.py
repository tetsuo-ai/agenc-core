"""Generate metadata and thin entrypoints. Run is file generation only."""
import json
from pathlib import Path
root = Path(__file__).resolve().parent
repos = {
 'more': ('https://github.com/more-itertools/more-itertools.git', '790bb0bb2c03e7a07282e5f16f4b1fde35b8fcf5'),
 'danger': ('https://github.com/pallets/itsdangerous.git', '672971d66a2ef9f85151e53283113f33d642dabd'),
}
common = (' Python 3 and standard-library unittest are available. pytest is not installed. Do not install dependencies; use unittest or direct Python checks. '
          'Work only in this repository. Do not inspect benchmark infrastructure or other runs. '
          'Keep all existing tests unchanged. You may add tests in tests/test_light_task.py. '
          'Do not use network access. Finish with a brief account of your changes and validation.')
def task(id, repo, category, size, prompt, **extra):
 url, sha = repos[repo]
 return dict(id=id, category=category, estimated_size=size, repo_url=url, repo_sha=sha,
             source_key=repo, prompt=prompt+common, setup_script=f'{id}/setup.py',
             check_script=f'{id}/check.py', timeout_seconds=300, **extra)
tasks = [
 task('01-chunked-strict', 'more', 'single-file-bug', 'small',
  'Fix a regression in more_itertools.chunked: strict=True currently accepts a final incomplete chunk. '
  'Strict mode must raise ValueError before yielding that incomplete chunk while retaining all documented behavior for exact batches, empty input, zero, negative, and None sizes.', mutation=True),
 task('02-split-limit', 'more', 'single-file-bug', 'small',
  'Fix more_itertools.split_at: maxsplit=0 should return the entire iterable as one list without invoking the predicate, but the current implementation still splits. '
  'Retain unlimited splitting, positive limits, separators, and one-shot iterable behavior.', mutation=True),
 task('03-window-padding', 'more', 'iterator-bug', 'medium',
  'Fix a regression in more_itertools.windowed: stepped windows can emit an extra all-padding window. '
  'The documented behavior for step smaller than, equal to, or larger than the window size must hold, including short and empty inputs. Preserve laziness.', mutation=True),
 task('04-count-by', 'more', 'multi-file-feature-tests', 'medium',
  'Add the public function count_by(iterable, key=None). Return a dict mapping each item, or key(item), to its occurrence count in first-seen key order. '
  'Consume a one-shot iterable once, invoke a provided key once per item, and return {} for empty input. '
  'Add the implementation and public export in more_itertools/more.py, its typed signature and export in more_itertools/more.pyi, a short docs/count_by.rst usage page, '
  'and at least four meaningful unittest tests in tests/test_light_task.py. Follow the repository style.', mutation=False),
 task('05-empty-refactor', 'more', 'behavior-preserving-refactor', 'medium',
  'Refactor first() and last() in more_itertools/more.py so their empty-input default-or-ValueError behavior is shared in a private helper named _handle_empty_iterable(name, default). '
  'Both functions must call the helper on empty input. Preserve the exact existing error messages, handling of explicit None or false defaults, generator support, and last() sequence fast path. '
  'Keep all public behavior unchanged.', mutation=False),
 task('06-key-rotation-map', 'danger', 'repo-question-search', 'small',
  'Trace signing key rotation and serializer fallback order in this repository. Do not change library code. '
  'Write ANSWER.json with these fields: signing_key_position ("first" or "last"); verification_key_order ("forward" or "reverse"); '
  'fallback_order (an array containing "configured_signer" and "fallback_signers" in attempted order); '
  'signing_evidence, verification_evidence, fallback_evidence (each an object with path relative to repo root and symbol such as "Signer.method"). '
  'Use the precise methods that select the signing key, iterate verification keys, and iterate fallback signers.', mutation=False),
 task('07-source-manifest', 'danger', 'shell-heavy', 'medium',
  'Add an executable POSIX shell script scripts/source-manifest.sh. Its optional first argument is the directory to inspect, default src/itsdangerous. '
  'Recursively list regular .py files in that directory as SHA256_HEX<TAB>RELATIVE_POSIX_PATH, sorted by relative path using byte ordering. '
  'Handle spaces in directory and file names, emit nothing for an empty directory, ignore non-Python files, and return a nonzero status for a missing directory. '
  'Do not change library code. Add docs/source-manifest.rst with usage and a sample. Python 3 or standard Linux tools may be used by the shell script.', mutation=False),
 task('08-integer-encoding', 'danger', 'single-file-bug', 'small',
  'Fix integer encoding round trips in itsdangerous.encoding. int_to_bytes currently drops significant trailing zero bytes, corrupting timestamps such as 256. '
  'Preserve the established minimal unsigned big-endian representation (zero encodes as empty bytes), round trips through 2**64-1, and current errors for values outside the unsigned 64-bit range.', mutation=True),
 task('09-separator-payload', 'danger', 'single-file-bug', 'small',
  'Fix Signer.unsign so a correctly signed payload containing the signer separator can be verified. '
  'Payloads may contain multiple separators and use a custom separator. Preserve tamper rejection, missing-signature errors, text input, and key rotation.', mutation=True),
 task('10-expiry-boundary', 'danger', 'boundary-bug', 'small',
  'Fix TimestampSigner expiry semantics: a signature exactly max_age seconds old should still be valid, while an older or future-dated signature is rejected. '
  'Retain max_age=None, max_age=0, aware UTC return_timestamp output, and the SignatureExpired payload/date_signed metadata.', mutation=True),
 task('11-compression-marker', 'danger', 'serialization-bug', 'medium',
  'Fix URLSafeSerializer compressed payload round trips. Large repetitive objects are compressed but currently fail to load. '
  'Restore the wire-format compression marker while keeping uncompressed small payloads unchanged, URL-safe output, tamper rejection, and informative BadPayload handling.', mutation=True),
 task('12-partition-map', 'more', 'deferred-planning-feature-tests', 'large',
  'Create a short task checklist using your available checklist or planning tool (such as TodoWrite). If no such tool is available, give a short text checklist. Do not enter a plan approval workflow. '
  'Add the public function partition_map(iterable, func). Call func(item) once per item; it returns a pair (accepted, value). '
  'Return a pair of lists (rejected, accepted), preserving input order within each list and deciding acceptance by truthiness. '
  'Consume a one-shot iterable once, return ([], []) for empty input, and let callback errors propagate. '
  'Add implementation/export in more_itertools/more.py, typed signature/export in more_itertools/more.pyi, docs/partition_map.rst with an example, '
  'and at least four meaningful unittest tests in tests/test_light_task.py. Follow repository style.', mutation=False,
  deferred_capability='checklist', deferred_validation='AgenC trace must show a successful TodoWrite/checklist call; Light must also show discovery/load; Pi may use a text checklist.'),
]
(root/'manifest.json').write_text(json.dumps(dict(schema_version=1, tasks=tasks), indent=2)+'\n')
for t in tasks:
 d=root/t['id']; d.mkdir(exist_ok=True)
 for op in ('setup','check'):
  (d/f'{op}.py').write_text(f'#!/usr/bin/env python3\nimport sys\nfrom pathlib import Path\nsys.path.insert(0, str(Path(__file__).resolve().parents[1]))\nfrom task_support import {op}\n{op}({t["id"]!r}, Path(sys.argv[1]).resolve())\n')
