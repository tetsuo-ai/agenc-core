import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const [control, treatment, output] = process.argv.slice(2);
assert(control && treatment && output);
const pins = ['aaf332b45d0ec7b2f6f7b6e223b5648c8bab2d6d', 'ec45a1e49a6e563391830b07ff54ac483bed5180'];
const cores = [resolve(control), resolve(treatment)];
const rows = [];
for (const [index, core] of cores.entries()) {
  const revision = spawnSync('git', ['-C', core, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  assert.equal(revision.status, 0);
  assert.equal(revision.stdout.trim(), pins[index]);
  const state = spawnSync('git', ['-C', core, 'status', '--porcelain'], { encoding: 'utf8' });
  assert.equal(state.status, 0);
  assert.equal(state.stdout, '');
  const scratch = mkdtempSync(join(tmpdir(), 'agenc-cold-cli-smoke-'));
  mkdirSync(join(scratch, 'empty'));
  const commands = [
    ['--version'], ['--help'], ['mcp', 'serve', '--help'], ['doctor', '--help'],
    ['skills', '--help'], ['trajectories', '--help'], ['skills', 'list', '--json'],
    ['skills', 'candidates', 'list', '--json'],
    ['trajectories', 'export', '--dir', join(scratch, 'empty'), '--format', 'sft'],
  ];
  for (const [commandIndex, args] of commands.entries()) {
    const result = spawnSync(process.execPath, [join(core, 'runtime/bin/agenc'), ...args], {
      cwd: scratch, env: { ...process.env, AGENC_HOME: join(scratch, 'state'),
        AGENC_WORKSPACE: scratch, NO_COLOR: '1' },
      encoding: 'utf8', timeout: 25_000, maxBuffer: 4 * 1024 * 1024,
    });
    const normalize = value => String(value ?? '').replaceAll(scratch, '<TEMP>');
    const stdout = normalize(result.stdout), stderr = normalize(result.stderr);
    rows.push({ arm: index === 0 ? 'control' : 'treatment', commandIndex,
      command: args.map(normalize), status: result.status, signal: result.signal,
      errorCode: result.error?.code ?? null, stdout, stderr,
      stdoutSha256: createHash('sha256').update(stdout).digest('hex') });
  }
}
writeFileSync(output, JSON.stringify({ pins, rows }, null, 2), { flag: 'wx', mode: 0o600 });
for (const row of rows) {
  assert.equal(row.status, 0, `${row.arm} command ${row.commandIndex}`);
  assert.equal(row.signal, null);
  assert.equal(row.errorCode, null);
  if (row.arm === 'treatment') {
    const previous = rows.find(other => other.arm === 'control' && other.commandIndex === row.commandIndex);
    assert.equal(row.stdout, previous.stdout, `stdout command ${row.commandIndex}`);
    assert.equal(row.stderr, previous.stderr, `stderr command ${row.commandIndex}`);
  }
  if (row.commandIndex === 6) assert.deepEqual(JSON.parse(row.stdout).errors, []);
}
console.log(JSON.stringify({ completed: rows.length, matchedPairs: rows.length / 2, pins }));
