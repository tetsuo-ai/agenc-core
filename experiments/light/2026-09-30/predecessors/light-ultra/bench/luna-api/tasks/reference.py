"""Reference solutions for checker self-validation only. Withhold from agents."""
from pathlib import Path
import json
import sys
from task_support import MUTATIONS, replace_once

def solve(task_id, repo):
    assert sys.platform.startswith('linux'), 'Reference validation executes only on Linux'
    if task_id in MUTATIONS:
        path, old, new = MUTATIONS[task_id]
        replace_once(repo/path, new, old)
        return
    if task_id in ('04-count-by','12-partition-map'):
        name = 'count_by' if task_id == '04-count-by' else 'partition_map'
        impl = '''\ndef count_by(iterable, key=None):
    """Count items by key while preserving first-seen order."""
    result = {}
    for item in iterable:
        value = item if key is None else key(item)
        result[value] = result.get(value, 0) + 1
    return result
''' if name == 'count_by' else '''\ndef partition_map(iterable, func):
    """Map items into rejected and accepted lists."""
    rejected, accepted = [], []
    for item in iterable:
        flag, value = func(item)
        (accepted if flag else rejected).append(value)
    return rejected, accepted
'''
        source=repo/'more_itertools/more.py'
        source.write_text(source.read_text().replace('__all__ = [', f"__all__ = [\n    '{name}',", 1)+impl)
        stub=repo/'more_itertools/more.pyi'
        signature = '\ndef count_by(iterable: Iterable[_T], key: Callable[[_T], Hashable] | None = None) -> dict[Hashable, int]: ...\n' if name=='count_by' else '\ndef partition_map(iterable: Iterable[_T], func: Callable[[_T], tuple[object, _U]]) -> tuple[list[_U], list[_U]]: ...\n'
        stub.write_text(stub.read_text().replace('__all__ = [', f"__all__ = [\n    '{name}',", 1)+signature)
        doc=repo/'docs'/f'{name}.rst'
        doc.write_text(f'{name}\n'+('='*len(name))+f'\n\nUse ``more_itertools.{name}`` to consume an iterable once and produce grouped results.\n\nExample::\n\n    from more_itertools import {name}\n')
        tests = '''import unittest
from more_itertools import count_by
class CountByTests(unittest.TestCase):
    def test_empty(self): self.assertEqual(count_by([]), {})
    def test_repeated(self): self.assertEqual(count_by('aba'), {'a': 2, 'b': 1})
    def test_key(self): self.assertEqual(count_by([-1, 1], abs), {1: 2})
    def test_generator(self): self.assertEqual(count_by(iter([2, 3])), {2: 1, 3: 1})
''' if name=='count_by' else '''import unittest
from more_itertools import partition_map
class PartitionMapTests(unittest.TestCase):
    def test_empty(self): self.assertEqual(partition_map([], lambda x: x), ([], []))
    def test_groups(self): self.assertEqual(partition_map([0, 1], lambda x: (x, str(x))), (['0'], ['1']))
    def test_generator(self): self.assertEqual(partition_map(iter([2, 3]), lambda x: (True, x)), ([], [2, 3]))
    def test_error(self):
        with self.assertRaises(ZeroDivisionError): partition_map([0], lambda x: (True, 1 / x))
'''
        (repo/'tests/test_light_task.py').write_text(tests)
    elif task_id == '05-empty-refactor':
        source=repo/'more_itertools/more.py'
        text=source.read_text()
        for name,indent in [('first',4),('last',8)]:
            pad=' '*indent
            old=(pad+"if default is _marker:\n"+pad+"    raise ValueError(\n"+pad+f"        '{name}() was called on an empty iterable, '\n"+pad+"        'and no default value was provided.'\n"+pad+"    )\n"+pad+"return default")
            assert text.count(old)==1
            text=text.replace(old,pad+f"return _handle_empty_iterable('{name}', default)",1)
        text += '''\n\ndef _handle_empty_iterable(name, default):
    if default is _marker:
        raise ValueError(
            f'{name}() was called on an empty iterable, '
            'and no default value was provided.'
        )
    return default
'''
        source.write_text(text)
    elif task_id == '06-key-rotation-map':
        (repo/'ANSWER.json').write_text(json.dumps({
            'signing_key_position':'last','verification_key_order':'reverse',
            'fallback_order':['configured_signer','fallback_signers'],
            'signing_evidence':{'path':'src/itsdangerous/signer.py','symbol':'Signer.derive_key'},
            'verification_evidence':{'path':'src/itsdangerous/signer.py','symbol':'Signer.verify_signature'},
            'fallback_evidence':{'path':'src/itsdangerous/serializer.py','symbol':'Serializer.iter_unsigners'},
        }))
    elif task_id == '07-source-manifest':
        script=repo/'scripts/source-manifest.sh'; script.parent.mkdir(exist_ok=True)
        script.write_text('''#!/bin/sh
set -eu
python3 - "${1:-src/itsdangerous}" <<'PYCODE'
import hashlib
from pathlib import Path
import sys
base = Path(sys.argv[1])
if not base.is_dir():
    raise SystemExit(1)
files = sorted((p for p in base.rglob('*.py') if p.is_file()), key=lambda p: p.relative_to(base).as_posix().encode())
for path in files:
    print(hashlib.sha256(path.read_bytes()).hexdigest() + '\\t' + path.relative_to(base).as_posix())
PYCODE
''')
        script.chmod(0o755)
        (repo/'docs/source-manifest.rst').write_text('''Source manifest
===============

Run ``scripts/source-manifest.sh`` to print SHA256 hashes of the package sources.
An optional argument selects a different source directory::

    scripts/source-manifest.sh src/itsdangerous
''')
    else:
        raise AssertionError(task_id)

if __name__ == '__main__':
    solve(sys.argv[1], Path(sys.argv[2]).resolve())
