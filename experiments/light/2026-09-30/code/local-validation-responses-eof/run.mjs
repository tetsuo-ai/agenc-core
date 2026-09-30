// Local clean dependency-tree validation of an immutable Git archive.
// Not a Linux, release reproducibility, performance or provider evaluation.
import { spawn, execFileSync } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, statfsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = '/private/tmp/light-takeover/startup-core';
const commit = process.argv[2];
if (!/^[a-f0-9]{40}$/.test(commit ?? '')) throw Error('Exact reviewed commit required');
if (execFileSync('git', ['rev-parse', 'HEAD'], {cwd:repo,encoding:'utf8'}).trim() !== commit || execFileSync('git',['status','--porcelain'],{cwd:repo,encoding:'utf8'}).trim()) throw Error('Selected commit must be clean current HEAD');
const toolchain = '/Users/tetsuoarena/claude-agenc/node/n/versions/node/26.8.1';
if (process.versions.node !== '26.8.1') throw Error('Wrong local Node version');
closeSync(openSync(join(here, 'started'), 'wx', 0o600));
const root = mkdtempSync('/private/tmp/light-clean-responses-eof-');
const source = join(root, 'source');
mkdirSync(source, { mode: 0o700 });
mkdirSync(join(root, 'tmp'), { mode: 0o700 });
const report = { commit, root, source, platform: process.platform, arch: process.arch,
  node: process.versions.node, started: new Date().toISOString(), steps: [], status: 'running' };
const save = () => writeFileSync(join(here, 'result.json'), JSON.stringify(report, null, 2) + '\n');
const space = () => { const s = statfsSync(root); if (s.bavail * s.bsize < 8 * 1024 ** 3) throw Error('Disk safety floor: less than 8 GiB free'); };
const env = { PATH: `${toolchain}/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
  ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
  TMPDIR: join(root, 'tmp'), LANG: 'C', LC_ALL: 'C', TZ: 'UTC', CI: 'true',
  AGENC_SKIP_POSTINSTALL: '1', AGENC_BUILD_COMMIT: commit,
  npm_config_userconfig: join(here, 'empty.npmrc'), npm_config_registry: 'https://registry.npmjs.org/',
  npm_config_nodedir: toolchain, npm_config_build_from_source: 'true',
  npm_config_strict_allow_scripts: 'true', npm_config_update_notifier: 'false',
  npm_config_audit: 'false', npm_config_fund: 'false' };
async function step(name, cmd, args, cwd = source, timeout = 600_000) {
  space();
  const log = join(here, `${name}.log`);
  const fd = openSync(log, 'wx', 0o600);
  const record = { name, started: new Date().toISOString(), log, status: 'running' };
  report.steps.push(record); save(); console.log(JSON.stringify({ step: name, status: 'running', root }));
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', fd, fd], detached: true });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, timeout);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', (code, signal) => {
        clearTimeout(timer); record.exitCode = code; record.signal = signal; record.timedOut = timedOut;
        code === 0 && !timedOut ? resolve() : reject(Error(`${name} failed: ${code ?? signal}`));
      });
    });
    record.status = 'passed';
  } catch (error) { record.status = 'failed'; throw error; }
  finally { closeSync(fd); record.finished = new Date().toISOString(); save(); }
  console.log(JSON.stringify({ step: name, status: record.status }));
}

try {
  space(); save();
  const archive = execFileSync('git', ['archive', '--format=tar', commit], { cwd: repo, maxBuffer: 256 * 1024 ** 2 });
  report.archiveSha256 = createHash('sha256').update(archive).digest('hex');
  execFileSync('tar', ['-xf', '-', '-C', source], { input: archive });
  const epoch = execFileSync('git', ['show', '-s', '--format=%ct', commit], { cwd: repo, encoding: 'utf8' }).trim();
  env.SOURCE_DATE_EPOCH = epoch; env.AGENC_BUILD_TIME = new Date(Number(epoch) * 1000).toISOString();
  report.sourceEpoch = epoch;
  const npm = join(toolchain, 'bin', 'npm');
  report.npm = execFileSync(npm, ['--version'], { env, encoding: 'utf8' }).trim();
  if (report.npm !== '11.17.0') throw Error('Wrong npm version');
  await step('install', npm, ['ci', '--prefer-offline', '--no-audit', '--no-fund', '--loglevel=error']);
  await step('typecheck', npm, ['run', 'typecheck', '--workspace=@tetsuo-ai/runtime']);
  await step('build', npm, ['run', 'build']);
  await step('focused-tests', process.execPath, ['scripts/run-hermetic-vitest.mjs', '--require-zero-skips', 'run',
    'tests/prompts/attachments',
    'tests/session/prepared-sampling-evidence.test.ts',
    'tests/session/run-turn.prepared-sampling-evidence.test.ts',
    'tests/session/run-turn.advisory-compaction.test.ts',
    'tests/budget/admitted-model-call.test.ts',
    'tests/budget/admitted-boundaries.integration.test.ts',
    'tests/llm/providers/openai', 'tests/llm/wire/responses-openai',
    'tests/llm/client-session.test.ts', 'tests/llm/client-session-body-lifetime.test.ts',
    'tests/llm/client-session-stream-close.test.ts', 'tests/llm/client-session.retry-after.test.ts',
    'tests/llm/providers/deepseek/provider.test.ts', 'tests/llm/wire/incomplete-tool-calls.test.ts',
    'tests/recovery/max-output-tokens.test.ts', 'tests/phases/stream-model.test.ts',
    'tests/session/run-turn.truncated-tool-recovery.test.ts', 'tests/session/light-reasoning-policy.test.ts',
    'tests/session/run-turn.responses-terminal-safety.test.ts',
    'tests/session/run-turn.light-write-admission.test.ts', '--maxWorkers=1', '--reporter=dot'], join(source, 'runtime'));
  report.version = JSON.parse(readFileSync(join(source, 'runtime/dist/VERSION'), 'utf8'));
  if (report.version.commit !== commit) throw Error('Built VERSION mismatch');
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.message; process.exitCode = 1; }
finally { report.finished = new Date().toISOString(); save(); console.log(JSON.stringify(report)); }

