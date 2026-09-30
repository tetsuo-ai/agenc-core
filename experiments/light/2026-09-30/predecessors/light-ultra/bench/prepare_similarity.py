"""Inventory the task's changed Git files for a text-free remote overlap scan."""
import json
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parent.parent
trees = {
    'core-converged': '3c954ea55',
    'core-actions': 'a5639cb4e', 'core-relative': '6c4c68431', 'core-focus': '9e7edc397', 'core': '1370385d69', 'core-context': 'e6a0e31df',
    'core-parity': '0d5ad1bed', 'core-speed': '41951e4b4',
    'core-output': '1a7642102', 'core-demand': 'd12664057',
    'core-notice': 'd12664057', 'core-catalog': '1a7642102',
    'core-frames': 'c2a6a35d4', 'core-directed': '55cfedd81', 'core-brief': '11e51dcc1',
    'desktop': 'c14a9f6c', 'benchmark': '1370385d69',
}
rows = []
for folder, base in trees.items():
    tree = root / folder
    def git(*args):
        return subprocess.check_output(['git', '-C', str(tree), *args]).decode()
    branch = git('branch', '--show-current').strip()
    revision = git('rev-parse', 'HEAD').strip()
    for name in git('diff', '--name-only', base).splitlines():
        path = tree / name
        if not path.is_file():
            continue
        if name.startswith('runtime/benchmarks/light-mode/evidence/') and path.suffix in ('.json', '.gz'):
            # Derived measurements contain protocol field names, hashes and counts.
            # They are not authored prompts, tool descriptions or implementation.
            continue
        diff = git('diff', '--unified=0', base, '--', name)
        added = '\n'.join(line[1:] for line in diff.splitlines()
                          if line.startswith('+') and not line.startswith('+++'))
        rows.append(dict(branch=branch, path=name, base=base, revision=revision,
                         content=path.read_text(), added=added))
# Frozen third-party benchmark repositories are inputs, not authored AgenC code.
fixtures = []
for tree in sorted((root / 'bench/sources').iterdir()):
    if not tree.is_dir():
        continue
    status = subprocess.check_output(['git', '-C', str(tree), 'status', '--porcelain']).decode()
    if status:
        raise ValueError('Frozen benchmark source has local changes: ' + tree.name)
    revision = subprocess.check_output(['git', '-C', str(tree), 'rev-parse', 'HEAD']).decode().strip()
    fixtures.append({'path': str(tree.relative_to(root)), 'revision': revision, 'clean': True})
(root / 'evidence/unchanged-source-inputs.json').write_text(json.dumps(fixtures, indent=2) + '\n')

# Include task-local source helpers as well as files proposed in Git branches.
for path in sorted((root / 'bench').rglob('*')):
    if path.is_relative_to(root / 'bench/sources'):
        continue
    if path.is_file() and path.suffix in ('.py', '.sh', '.js', '.cjs', '.mjs', '.ts', '.tsx') and not path.name.startswith('._'):
        content = path.read_text()
        rows.append(dict(branch='task-local', path=str(path.relative_to(root)), base=None,
                         revision=None, content=content, added=content))
output = root / 'evidence/similarity-input-latest.json'
output.write_text(json.dumps(rows))
print(json.dumps({'changed_files': len(rows), 'output': str(output)}))
