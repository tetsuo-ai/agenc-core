#!/usr/bin/env python3
"""Offline built CLI/MCP version contract with a fresh private HOME."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

core = Path(sys.argv[1]).resolve()
expected = json.loads((core/'runtime/package.json').read_text())['version']
root = Path(tempfile.mkdtemp(prefix='light-mcp-version-'))
home = root/'home'
home.mkdir(mode=0o700)
(home/'agenc').mkdir(mode=0o700)
trust = home/'agenc/trusted-projects.json'
trust.write_text(json.dumps({'version': 1, 'trustedProjects': [
    {'path': str(root), 'trustedAt': '2026-09-30T00:00:00Z'}]}))
trust.chmod(0o600)
config = root/'config.toml'
config.write_text('config_version = 2\n')
env = {k: os.environ[k] for k in ('PATH', 'LANG', 'LC_ALL', 'TZ') if k in os.environ}
env.update(HOME=str(home), AGENC_HOME=str(home/'agenc'), CI='1')
cli = ['node', str(core/'runtime/bin/agenc')]
version = subprocess.run(cli+['--version'], cwd=root, env=env, text=True,
                         capture_output=True, timeout=30)
assert version.returncode == 0 and version.stdout.strip() == 'agenc '+expected, version.stdout
request = {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {
    'protocolVersion': '2024-11-05', 'capabilities': {},
    'clientInfo': {'name': 'offline-version-probe', 'version': '1'}}}
result = subprocess.run(cli+['mcp', 'serve', '--transport', 'stdio'],
    cwd=root, env=env, input=json.dumps(request)+'\n', text=True,
    capture_output=True, timeout=30)
messages = [json.loads(line) for line in result.stdout.splitlines() if line.startswith('{')]
reply = [message for message in messages if message.get('id') == 1]
assert result.returncode == 0, {'exit': result.returncode, 'stderr': result.stderr}
assert len(reply) == 1 and 'result' in reply[0], reply
info = reply[0]['result']['serverInfo']
assert info['version'] == expected, info
print(json.dumps({'cli_version': version.stdout.strip(), 'mcp_server_info': info,
                  'exit_code': result.returncode, 'provider_calls': 0}))
