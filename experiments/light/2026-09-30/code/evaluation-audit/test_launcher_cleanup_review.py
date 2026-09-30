"""Execute only selected cleanup AST with fake Docker/Popen, never the launcher."""
import ast
import hashlib
import json
from pathlib import Path
import re
from types import SimpleNamespace
import unittest

SOURCE = Path(__file__).with_name('launcher-028a56ba-snapshot.py.txt')
SOURCE_SHA = '028a56ba03fda860a0d05e6a40afb8c8f2f5e71e37b88f7a5f03f72d09be1f9e'


class TimeoutExpired(Exception):
    pass


class Client:
    def __init__(self, steps):
        self.steps = list(steps)
        self.returncode = None
        self.kills = 0
        self.waits = []

    def communicate(self, timeout):
        self.waits.append(timeout)
        step = self.steps.pop(0)
        if isinstance(step, BaseException):
            raise step
        self.returncode = 0 if self.kills == 0 else -9
        return step

    def poll(self):
        return self.returncode

    def kill(self):
        self.kills += 1


def exercise(path=SOURCE, expected=SOURCE_SHA, *, steps=None, docker_fault=None):
    raw = path.read_bytes()
    assert hashlib.sha256(raw).hexdigest() == expected
    tree = ast.parse(raw)
    helpers = [n for n in tree.body if isinstance(n, ast.FunctionDef)
               and n.name in ('docker', 'owned_ids', 'contain_owned')]
    start = next(i for i, n in enumerate(tree.body) if isinstance(n, ast.Try)
                 and any(isinstance(x, ast.Assign) and ast.unparse(x.value).startswith('subprocess.Popen(')
                         for x in n.body))
    # Only the main try/finally and result statements; imports, argparse, filesystem
    # setup and all actual process creation are excluded or replaced by fakes.
    code = compile(ast.Module(body=helpers + tree.body[start:], type_ignores=[]), str(path), 'exec')
    client = Client(steps or [('', '')])
    actions = []
    saved = []
    def docker_run(command, **kwargs):
        actions.append(command)
        if docker_fault:
            return docker_fault(command)
        return SimpleNamespace(returncode=0, stdout='')
    env = dict(json=json, re=re, subprocess=SimpleNamespace(
        run=docker_run, Popen=lambda *a, **kw: client,
        TimeoutExpired=TimeoutExpired, PIPE=object()),
        command=['no-real-command'], identity='review-owned', name='light-canonical-review-owned',
        cidfile=SimpleNamespace(read_text=lambda: ''), args=SimpleNamespace(case='normal'),
        time=SimpleNamespace(monotonic=lambda: 1), started=0,
        result=Path('/synthetic/result'), process=None, timed_out=False,
        containment=[], stdout='', stderr='', outer_errors=[], remaining=None,
        save=lambda path, value: saved.append((path, value)), print=lambda *a, **kw: None)
    exit_code = 0
    try:
        exec(code, env)
    except SystemExit as error:
        exit_code = error.code
    return client, actions, saved[-1][1], exit_code


class FrozenLauncherReview(unittest.TestCase):
    def test_normal_completion_queries_only_owned_scope(self):
        client, actions, report, status = exercise()
        self.assertEqual(status, 0)
        self.assertEqual(client.kills, 0)
        self.assertFalse(report['owned_container_still_running'])
        self.assertTrue(all('label=light.probe.launch=review-owned' in a for a in actions))

    def test_control_plane_timeouts_are_retained_as_uncertainty(self):
        def failure(_command):
            raise TimeoutExpired()
        _, _, report, status = exercise(docker_fault=failure)
        self.assertEqual(status, 2)
        self.assertIsNone(report['owned_container_still_running'])
        self.assertTrue(report['outer_errors'])

    def test_cleanup_io_error_still_kills_and_joins_owned_client(self):
        client, _, report, status = exercise(steps=[TimeoutExpired(), OSError('synthetic I/O'), ('', '')])
        self.assertEqual(status, 2)
        self.assertTrue(report['timed_out'])
        self.assertFalse(report['owned_container_still_running'])
        self.assertEqual(client.returncode, -9)
        self.assertEqual(client.kills, 1)
        self.assertEqual(client.waits, [90, 15, 5])

    def test_control_errors_cannot_skip_independent_owned_client_reap(self):
        def failure(_command):
            raise OSError('synthetic control I/O')
        client, _, report, status = exercise(
            steps=[TimeoutExpired(), TimeoutExpired(), ('', '')], docker_fault=failure)
        self.assertEqual(status, 2)
        self.assertEqual(client.kills, 1)
        self.assertEqual(client.waits, [90, 15, 5])
        self.assertIsNone(report['owned_container_still_running'])

    def test_late_owned_container_is_verified_then_killed_after_client_reap(self):
        cid = 'a' * 64
        queries = 0
        killed = False
        def response(command):
            nonlocal queries, killed
            if command[1] == 'ps':
                queries += 1
                # First containment passes see no container; daemon creation
                # becomes visible only after the owned client has been reaped.
                return SimpleNamespace(returncode=0, stdout='' if queries < 3 or killed else cid+'\n')
            if command[1] == 'inspect':
                return SimpleNamespace(returncode=0, stdout=json.dumps([{
                    'Id': cid, 'Name': '/light-canonical-review-owned',
                    'Config': {'Labels': {'light.probe.launch': 'review-owned'}},
                    'State': {'Running': True}}]))
            if command[1] == 'kill':
                self.assertEqual(command[2], cid)
                killed = True
                return SimpleNamespace(returncode=0, stdout='')
            self.fail('unexpected Docker command')
        client, _, report, status = exercise(
            steps=[TimeoutExpired(), TimeoutExpired(), ('', '')], docker_fault=response)
        self.assertEqual(status, 2)
        self.assertEqual(client.kills, 1)
        self.assertTrue(killed)
        self.assertFalse(report['owned_container_still_running'])

    def test_identity_mismatch_never_kills_container_and_remains_failed(self):
        cid = 'a' * 64
        def response(command):
            if command[1] == 'ps':
                return SimpleNamespace(returncode=0, stdout=cid+'\n')
            if command[1] == 'inspect':
                return SimpleNamespace(returncode=0, stdout=json.dumps([{
                    'Id': cid, 'Name': '/some-other-name',
                    'Config': {'Labels': {'light.probe.launch': 'review-owned'}},
                    'State': {'Running': True}}]))
            self.fail('identity mismatch must not send kill')
        _, actions, report, status = exercise(docker_fault=response)
        self.assertEqual(status, 2)
        self.assertTrue(report['owned_container_still_running'])
        self.assertFalse(any(a[1] == 'kill' for a in actions))


if __name__ == '__main__':
    unittest.main()
