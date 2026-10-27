import { describe, expect, it, vi } from 'vitest';
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('node:child_process', () => {
  const execFile = () => {};
  execFile[Symbol.for('nodejs.util.promisify.custom')] = invoke;
  return { execFile };
});
import { probeGitStatus } from '../../src/tui/git-status.js';

const stdout = '# branch.oid abcdef1234\0# branch.head main\0';
describe('bounded git status subprocess', () => {
  it('uses one hardened invocation with the session cwd and a one second timeout', async () => {
    invoke.mockResolvedValueOnce({ stdout });
    expect(await probeGitStatus('/session/workspace')).toMatchObject({ branch: 'main' });
    expect(invoke).toHaveBeenLastCalledWith('git', [
      '-c', 'core.fsmonitor=false', '--no-optional-locks', 'status',
      '--porcelain=v2', '--branch', '-z', '--untracked-files=all',
    ], expect.objectContaining({
      cwd: '/session/workspace', timeout: 1000, encoding: 'utf8',
      env: expect.objectContaining({ GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }),
    }));
  });
  it.each(['ENOENT', 'ETIMEDOUT', 'failed'])('hides failures: %s', async code => {
    invoke.mockRejectedValueOnce(Object.assign(new Error(code), { code }));
    expect(await probeGitStatus('/session/workspace')).toBeNull();
  });
  it('deduplicates the same cwd and never overlaps different cwd probes', async () => {
    invoke.mockClear();
    let finish!: (result: { stdout: string }) => void;
    invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    invoke.mockResolvedValueOnce({ stdout });
    const first = probeGitStatus('/one');
    expect(probeGitStatus('/one')).toBe(first);
    const second = probeGitStatus('/two');
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    finish({ stdout });
    expect(await first).toMatchObject({ branch: 'main' });
    expect(await second).toMatchObject({ branch: 'main' });
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
