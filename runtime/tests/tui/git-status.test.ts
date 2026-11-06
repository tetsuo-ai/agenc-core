import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseGitStatus, probeGitStatus } from '../../src/tui/git-status.js';
import { validateTuiConfig, defaultConfig } from '../../src/config/schema.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function repo() {
  const cwd = mkdtempSync(join(tmpdir(), 'agenc-git-chrome-'));
  roots.push(cwd);
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: {
    ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test',
  } });
  git('init', '-b', 'main');
  return { cwd, git };
}
const headers = '# branch.oid abcdef1234567890\0# branch.head main\0';
describe('git composer status', () => {
  it('parses clean, unborn, detached, and missing upstream states', () => {
    expect(parseGitStatus(headers)).toEqual({ branch: 'main', changed: 0, ahead: 0, behind: 0 });
    expect(parseGitStatus('# branch.oid (initial)\0# branch.head new\0')?.branch).toBe('new');
    expect(parseGitStatus('# branch.oid abcdef1234567890\0# branch.head (detached)\0')?.branch).toBe('abcdef1');
    expect(parseGitStatus('# branch.oid (initial)\0# branch.head (detached)\0')).toBeNull();
    expect(parseGitStatus('')).toBeNull();
    expect(parseGitStatus('# branch.oid (initial)\0')).toBeNull();
  });
  it('strips control bytes from ref names before they reach the terminal', () => {
    expect(parseGitStatus('# branch.oid abcdef1234567890\0# branch.head feat\x07ure\0')?.branch)
      .toBe('feature');
    expect(parseGitStatus('# branch.oid abcdef1234567890\0# branch.head \x07\x1b\0')).toBeNull();
  });
  it('counts each record once, skips rename source paths, and combines ahead and behind', () => {
    const records = [headers, '# branch.upstream origin/main', '# branch.ab +1 -2',
      '1 MM N... 100644 100644 100644 a b both',
      '1 .M N... 100644 100644 100644 a b unstaged',
      '2 R. N... 100644 100644 100644 a b R100 renamed', '? looks-like-record\nold',
      '? untracked\n1 fake', 'u UU N... 100644 100644 100644 100644 a b c conflict', '! ignored',
    ].join('\0');
    expect(parseGitStatus(records)).toEqual({ branch: 'main', changed: 5, ahead: 1, behind: 2 });
    expect(parseGitStatus(headers + '# branch.ab +9 -8\0')).toMatchObject({ ahead: 0, behind: 0 });
  });
  it('probes real staged, unstaged, untracked, rename, detached and upstream states', async () => {
    const { cwd, git } = repo();
    expect(await probeGitStatus(cwd)).toEqual({ branch: 'main', changed: 0, ahead: 0, behind: 0 });
    for (const name of ['both', 'unstaged', 'old']) writeFileSync(join(cwd, name), 'initial\n');
    git('add', '.'); git('commit', '-m', 'initial');
    git('branch', 'upstream'); git('branch', '--set-upstream-to=upstream');
    writeFileSync(join(cwd, 'committed'), 'next'); git('add', '.'); git('commit', '-m', 'ahead');
    writeFileSync(join(cwd, 'both'), 'staged'); git('add', 'both');
    writeFileSync(join(cwd, 'both'), 'also unstaged'); writeFileSync(join(cwd, 'unstaged'), 'change');
    git('mv', 'old', 'renamed'); mkdirSync(join(cwd, 'new'));
    writeFileSync(join(cwd, 'new', 'one'), 'one'); writeFileSync(join(cwd, 'new', 'two'), 'two');
    expect(await probeGitStatus(cwd)).toEqual({ branch: 'main', changed: 5, ahead: 1, behind: 0 });
    git('reset', '--hard');
    git('checkout', 'upstream');
    writeFileSync(join(cwd, 'behind'), 'upstream change'); git('add', 'behind'); git('commit', '-m', 'behind');
    git('checkout', 'main');
    expect(await probeGitStatus(cwd)).toEqual({ branch: 'main', changed: 2, ahead: 1, behind: 1 });
    git('reset', '--hard', 'upstream');
    git('checkout', '--detach');
    expect((await probeGitStatus(cwd))?.branch).toBe(git('rev-parse', '--short=7', 'HEAD').trim());
    const outside = mkdtempSync(join(tmpdir(), 'agenc-nonrepo-')); roots.push(outside);
    expect(await probeGitStatus(outside)).toBeNull();
    expect(await probeGitStatus(join(outside, 'missing'))).toBeNull();
  });
  it('never executes repository fsmonitor code', async () => {
    const { cwd, git } = repo();
    writeFileSync(join(cwd, 'tracked'), 'initial'); git('add', '.'); git('commit', '-m', 'initial');
    const marker = join(cwd, 'executed');
    const script = join(cwd, '.git', 'monitor');
    writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\n`); chmodSync(script, 0o755);
    git('config', 'core.fsmonitor', script);
    git('status', '--porcelain=v2');
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    expect(await probeGitStatus(cwd)).toEqual({ branch: 'main', changed: 0, ahead: 0, behind: 0 });
    expect(existsSync(marker)).toBe(false);
  });
  it('validates the default-on hide preference', () => {
    expect(defaultConfig().tui?.gitStatusEnabled).toBe(true);
    expect(validateTuiConfig({ gitStatusEnabled: false })).toEqual({ gitStatusEnabled: false });
    expect(() => validateTuiConfig({ gitStatusEnabled: 'false' })).toThrow(/expected boolean/);
  });
});
