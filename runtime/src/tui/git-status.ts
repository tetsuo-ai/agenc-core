import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export type GitStatus = {
  readonly branch: string;
  readonly changed: number;
  readonly ahead: number;
  readonly behind: number;
};

/** Porcelain v2 with -z: a rename has one extra NUL-delimited source path. */
export function parseGitStatus(output: string): GitStatus | null {
  let branch = '';
  let oid = '';
  let upstream = false;
  let changed = 0;
  let ahead = 0;
  let behind = 0;
  const records = output.split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (record.startsWith('# branch.head ')) branch = record.slice(14);
    else if (record.startsWith('# branch.oid ')) oid = record.slice(13);
    else if (record.startsWith('# branch.upstream ')) upstream = true;
    else if (record.startsWith('# branch.ab ')) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(record);
      if (match) { ahead = Number(match[1]); behind = Number(match[2]); }
    } else if (/^[12u?] /.test(record)) {
      changed++;
      if (record.startsWith('2 ')) i++;
    }
  }
  if (branch === '(detached)') branch = /^[a-f0-9]+$/i.test(oid) ? oid.slice(0, 7) : '';
  // Ref names normally cannot contain controls. Keep malformed output off the terminal.
  branch = branch.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
  return branch ? { branch, changed, ahead: upstream ? ahead : 0, behind: upstream ? behind : 0 } : null;
}

const execFileAsync = promisify(execFile);
const pending = new Map<string, Promise<GitStatus | null>>();
let probeTail: Promise<unknown> = Promise.resolve();

/** Deduplicate callers and serialize across cwd changes, including an old unmounted session. */
export function probeGitStatus(cwd: string): Promise<GitStatus | null> {
  const existing = pending.get(cwd);
  if (existing) return existing;
  const result = probeTail.then(async () => {
    try {
      const { stdout } = await execFileAsync('git', [
        '-c', 'core.fsmonitor=false', '--no-optional-locks',
        'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all',
      ], {
        cwd, encoding: 'utf8', timeout: 1000,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      });
      return parseGitStatus(stdout);
    } catch {
      return null;
    }
  }).finally(() => { pending.delete(cwd); });
  pending.set(cwd, result);
  probeTail = result;
  return result;
}
