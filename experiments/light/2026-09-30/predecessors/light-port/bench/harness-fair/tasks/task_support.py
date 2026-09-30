"""Withheld deterministic checks for the Light mode benchmark.

Run only on Linux. The repository under test is the only untrusted argument.
No provider credentials are used here.
"""
from __future__ import annotations
import ast
import atexit
import hashlib
import importlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
TASKS = {t['id']: t for t in json.loads((HERE/'manifest.json').read_text())['tasks']}
# Original text -> seeded regression. Replacements must match exactly once.
MUTATIONS = {
 '01-chunked-strict': ('more_itertools/more.py', 'if len(chunk) != n:', 'if len(chunk) > n:'),
 '02-split-limit': ('more_itertools/more.py', '    if maxsplit == 0:\n        yield list(iterable)\n        return\n', '    if maxsplit < -1:\n        yield list(iterable)\n        return\n'),
 '03-window-padding': ('more_itertools/more.py', 'padding = (fillvalue,) * (n - 1 if step >= n else step - 1)', 'padding = (fillvalue,) * (n if step >= n else step)'),
 '08-integer-encoding': ('src/itsdangerous/encoding.py', 'return _int_to_bytes(num).lstrip(b"\\x00")', 'return _int_to_bytes(num).strip(b"\\x00")'),
 '09-separator-payload': ('src/itsdangerous/signer.py', 'value, sig = signed_value.rsplit(self.sep, 1)', 'value, sig = signed_value.split(self.sep, 1)'),
 '10-expiry-boundary': ('src/itsdangerous/timed.py', 'if age > max_age:', 'if age >= max_age:'),
 '11-compression-marker': ('src/itsdangerous/url_safe.py', 'base64d = b"." + base64d', 'base64d = base64d'),
}

def git(repo, *args):
    return subprocess.check_output(['git', '-C', str(repo), *args], stderr=subprocess.PIPE)

def replace_once(path, old, new):
    text = path.read_text()
    assert text.count(old) == 1, f'mutation mismatch: {path.name}'
    path.write_text(text.replace(old, new, 1))

def setup(task_id, repo):
    assert sys.platform.startswith('linux'), 'Task setups/checks execute only on Linux'
    task = TASKS[task_id]
    assert git(repo, 'rev-parse', 'HEAD').decode().strip() == task['repo_sha'], 'wrong source commit'
    assert not git(repo, 'status', '--porcelain').strip(), 'setup requires fresh clean checkout'
    if task_id in MUTATIONS:
        path, old, new = MUTATIONS[task_id]
        replace_once(repo/path, old, new)
    print(json.dumps({'task': task_id, 'setup': 'ok'}))

def assert_raises(kind, callback):
    try:
        callback()
    except kind as e:
        return e
    raise AssertionError(f'Expected {kind.__name__}')

def no_tamper(task, repo):
    sha = task['repo_sha']
    assert git(repo, 'rev-parse', 'HEAD').decode().strip() == sha, 'source commit changed'
    paths = git(repo, 'ls-tree', '-r', '--name-only', sha, 'tests').decode().splitlines()
    for path in paths:
        original = git(repo, 'show', f'{sha}:{path}')
        assert (repo/path).is_file() and (repo/path).read_bytes() == original, f'original test modified: {path}'
    # These tasks ask for analysis/artifacts only; library changes cannot make a check pass.
    if task['id'] in ('06-key-rotation-map', '07-source-manifest'):
        assert not git(repo, 'diff', sha, '--', 'src').strip(), 'unexpected library change'

def import_library(task, repo):
    source = repo if task['source_key'] == 'more' else repo/'src'
    sys.path.insert(0, str(source))
    name = 'more_itertools' if task['source_key'] == 'more' else 'itsdangerous'
    return importlib.import_module(name)

def upstream_more(repo, *classes):
    spec = importlib.util.spec_from_file_location('light_upstream_test_more', repo/'tests/test_more.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    suite = unittest.TestSuite(unittest.defaultTestLoader.loadTestsFromTestCase(getattr(module, c)) for c in classes)
    result = unittest.TextTestRunner(stream=io.StringIO()).run(suite)
    assert result.wasSuccessful(), f'upstream regression tests failed: {len(result.failures)} failures, {len(result.errors)} errors'

def added_tests(repo):
    path = repo/'tests/test_light_task.py'
    assert path.is_file(), 'feature needs tests/test_light_task.py'
    spec = importlib.util.spec_from_file_location('light_added_tests', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    suite = unittest.defaultTestLoader.loadTestsFromModule(module)
    assert suite.countTestCases() >= 4, 'feature needs at least four unittest tests'
    result = unittest.TextTestRunner(stream=io.StringIO()).run(suite)
    assert result.wasSuccessful() and not result.skipped, 'new feature tests fail or skip'

def feature_surface(repo, name):
    more = importlib.import_module('more_itertools.more')
    assert name in more.__all__, 'public implementation export missing'
    stub = ast.parse((repo/'more_itertools/more.pyi').read_text())
    definitions = [n for n in stub.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == name]
    assert definitions and definitions[0].returns is not None, 'typed stub signature missing'
    assert all(a.annotation is not None for a in definitions[0].args.args), 'stub parameter annotation missing'
    exports = next(n.value for n in stub.body if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == '__all__' for t in n.targets))
    assert name in ast.literal_eval(exports), 'stub export missing'
    doc = (repo/'docs'/f'{name}.rst').read_text()
    assert name in doc and len(doc.strip()) >= 80, 'feature usage documentation missing'
    added_tests(repo)

def check(task_id, repo):
    assert sys.platform.startswith('linux'), 'Task setups/checks execute only on Linux'
    task = TASKS[task_id]
    # Ignore bytecode produced by the agent, including same-size same-second edits.
    bytecode_cache = tempfile.TemporaryDirectory(prefix='.light-check-cache-', dir=repo)
    atexit.register(bytecode_cache.cleanup)
    sys.pycache_prefix = bytecode_cache.name
    sys.dont_write_bytecode = True
    no_tamper(task, repo)
    lib = import_library(task, repo)
    if task_id == '01-chunked-strict':
        for n in (1,2,3,5):
            for size in range(10):
                f=lambda: list(lib.chunked(iter(range(size)), n, strict=True))
                if size % n:
                    assert_raises(ValueError, f)
                else:
                    assert f() == [list(range(size))[i:i+n] for i in range(0,size,n)]
        upstream_more(repo, 'ChunkedTests')
    elif task_id == '02-split-limit':
        assert list(lib.split_at(iter('abc'), lambda _: (_ for _ in ()).throw(AssertionError('predicate called')), maxsplit=0)) == [list('abc')]
        assert list(lib.split_at([], bool, maxsplit=0)) == [[]]
        assert list(lib.split_at('a,b,c', lambda x: x==',', maxsplit=1, keep_separator=True)) == [['a'],[','],['b',',','c']]
        upstream_more(repo, 'SplitAtTests')
    elif task_id == '03-window-padding':
        for n in range(1,6):
            for step in range(1,7):
                for size in range(12):
                    xs=list(range(size)); expected=[]
                    if size:
                        expected.append(tuple(xs[:n]+[None]*max(0,n-size)))
                        if size >= n:
                            for start in range(step,size,step):
                                if start+n > size+min(step,n)-1:
                                    break
                                expected.append(tuple(xs[start:start+n]+[None]*max(0,start+n-size)))
                    assert list(lib.windowed(iter(xs), n, step=step)) == expected, (size,n,step)
        upstream_more(repo, 'WindowedTests')
    elif task_id == '04-count-by':
        assert lib.count_by(iter('abacbab')) == {'a':3,'b':3,'c':1}
        assert list(lib.count_by('cabca')) == ['c','a','b']
        assert lib.count_by([]) == {}
        seen=[]
        assert lib.count_by(iter([1,-1,2,-2,3]), lambda x: seen.append(x) or abs(x)) == {1:2,2:2,3:1}
        assert seen == [1,-1,2,-2,3]
        assert lib.count_by([[],[1],[2]], lambda x: len(x)) == {0:1,1:2}
        assert_raises(TypeError, lambda: lib.count_by([[]]))
        feature_surface(repo, 'count_by')
    elif task_id == '05-empty-refactor':
        tree=ast.parse((repo/'more_itertools/more.py').read_text())
        defs={n.name:n for n in tree.body if isinstance(n,ast.FunctionDef)}
        assert '_handle_empty_iterable' in defs, 'shared helper missing'
        for name in ('first','last'):
            assert any(isinstance(n,ast.Call) and isinstance(n.func,ast.Name) and n.func.id=='_handle_empty_iterable' for n in ast.walk(defs[name])), f'{name} must share helper'
            for default in (None,False,0,[],object()):
                assert getattr(lib,name)(iter([]),default) is default
            error=assert_raises(ValueError, lambda: getattr(lib,name)(iter([])))
            assert str(error)==f'{name}() was called on an empty iterable, and no default value was provided.'
        assert lib.first(iter([None,False,1])) is None
        assert lib.last(iter([None,False,1])) == 1
        upstream_more(repo,'FirstTests','LastTests')
    elif task_id == '06-key-rotation-map':
        actual=json.loads((repo/'ANSWER.json').read_text())
        expected={
            'signing_key_position':'last','verification_key_order':'reverse',
            'fallback_order':['configured_signer','fallback_signers'],
            'signing_evidence':{'path':'src/itsdangerous/signer.py','symbol':'Signer.derive_key'},
            'verification_evidence':{'path':'src/itsdangerous/signer.py','symbol':'Signer.verify_signature'},
            'fallback_evidence':{'path':'src/itsdangerous/serializer.py','symbol':'Serializer.iter_unsigners'},
        }
        for key,value in expected.items():
            assert actual[key] == value, f'wrong repository answer: {key}'
    elif task_id == '07-source-manifest':
        script=repo/'scripts/source-manifest.sh'
        assert script.is_file() and script.stat().st_mode & stat.S_IXUSR, 'executable shell script missing'
        assert script.read_text().startswith('#!'), 'shell script shebang missing'
        doc=(repo/'docs/source-manifest.rst').read_text()
        assert 'source-manifest.sh' in doc and len(doc.strip())>=80, 'script usage documentation missing'
        def expected(base):
            files=sorted((p for p in base.rglob('*.py') if p.is_file()),key=lambda p:p.relative_to(base).as_posix().encode())
            return ''.join(hashlib.sha256(p.read_bytes()).hexdigest()+'\t'+p.relative_to(base).as_posix()+'\n' for p in files)
        def run(*args):
            return subprocess.run(['/bin/sh',str(script),*map(str,args)],cwd=repo,capture_output=True,text=True,timeout=10)
        result=run(); assert result.returncode==0 and result.stdout==expected(repo/'src/itsdangerous'), 'default manifest wrong'
        with tempfile.TemporaryDirectory(prefix='manifest space ',dir=repo) as tmp:
            base=Path(tmp); (base/'nested space').mkdir(); (base/'a.py').write_bytes(b'pass\n')
            (base/'nested space'/'b c.py').write_bytes(b'# unicode \\n\n')
            (base/'ignore.txt').write_text('not Python')
            result=run(base); assert result.returncode==0 and result.stdout==expected(base), 'space/recursive manifest wrong'
            (base/'empty').mkdir(); result=run(base/'empty'); assert result.returncode==0 and result.stdout=='', 'empty directory wrong'
            assert run(base/'missing').returncode != 0, 'missing directory must fail'
    elif task_id == '08-integer-encoding':
        import struct
        from itsdangerous.encoding import int_to_bytes, bytes_to_int
        for n in [0,1,127,128,255,256,512,65536,2**32,2**64-1]+[k*256 for k in range(1,20)]:
            value=int_to_bytes(n)
            assert value == (n.to_bytes(8,'big').lstrip(b'\0'))
            assert bytes_to_int(value)==n
        assert_raises(struct.error,lambda:int_to_bytes(-1))
        assert_raises(struct.error,lambda:int_to_bytes(2**64))
    elif task_id == '09-separator-payload':
        for sep in (b'.',b':',b'~'):
            old=lib.Signer(b'old',sep=sep); rotated=lib.Signer([b'old',b'new'],sep=sep)
            for payload in (b'',sep,b'a'+sep+b'b'+sep+b'c',b'plain'):
                signed=old.sign(payload)
                assert rotated.unsign(signed)==payload
                assert rotated.unsign(signed.decode())==payload
                assert not rotated.validate(signed+b'x')
                assert_raises(lib.BadSignature,lambda:rotated.unsign(b'x'+signed))
            assert_raises(lib.BadSignature,lambda:rotated.unsign(b'noseparator'))
    elif task_id == '10-expiry-boundary':
        from datetime import timezone
        class ClockSigner(lib.TimestampSigner):
            now=1000
            def get_timestamp(self): return self.now
        signer=ClockSigner('test-only-secret'); signed=signer.sign(b'hello')
        assert signer.unsign(signed,max_age=0)==b'hello'
        signer.now=1010; assert signer.unsign(signed,max_age=10)==b'hello'
        signer.now=1011; error=assert_raises(lib.SignatureExpired,lambda:signer.unsign(signed,max_age=10))
        assert error.payload==b'hello' and error.date_signed.tzinfo==timezone.utc
        signer.now=999; assert_raises(lib.SignatureExpired,lambda:signer.unsign(signed,max_age=10))
        signer.now=999999; value,date=signer.unsign(signed,max_age=None,return_timestamp=True)
        assert value==b'hello' and date.tzinfo==timezone.utc and date.timestamp()==1000
    elif task_id == '11-compression-marker':
        serializer=lib.URLSafeSerializer('test-only-secret')
        for value in ({'many':'abc'*1000},['same']*1000,{'small':1},'',None):
            signed=serializer.dumps(value)
            assert serializer.loads(signed)==value
            assert set(signed) <= set('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.')
            assert_raises(lib.BadSignature,lambda:serializer.loads(signed+'x'))
        assert serializer.dump_payload({'many':'abc'*1000}).startswith(b'.')
        assert not serializer.dump_payload({'small':1}).startswith(b'.')
        error=assert_raises(lib.BadPayload,lambda:serializer.load_payload(b'.bm90LXpsaWI'))
        assert error.original_error is not None
    elif task_id == '12-partition-map':
        assert lib.partition_map(iter(range(7)),lambda x:(x%2==0,x*x)) == ([1,9,25],[0,4,16,36])
        assert lib.partition_map([],lambda x:x) == ([],[])
        seen=[]
        assert lib.partition_map(iter([0,1,2]),lambda x:(seen.append(x) or x,str(x))) == (['0'],['1','2'])
        assert seen==[0,1,2]
        assert lib.partition_map([False,[],[1],True],lambda x:(x,x)) == ([False,[]],[[1],True])
        assert_raises(RuntimeError,lambda:lib.partition_map([1],lambda _:(_ for _ in ()).throw(RuntimeError('expected'))))
        feature_surface(repo,'partition_map')
    else:
        raise AssertionError('unknown task')
    print(json.dumps({'task':task_id,'pass':True,'original_tests_unchanged':True}))
