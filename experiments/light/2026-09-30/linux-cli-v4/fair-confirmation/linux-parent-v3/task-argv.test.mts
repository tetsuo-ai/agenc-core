// Regression for the cli-three fixture defect: v2 passed `-p TASK --light ...`,
// so canonical parsing ended at TASK and every later flag became prompt text.
// Runs the canonical Core parser from CORE_RUNTIME (runtime/src must equal 403da).
// Usage: CORE_RUNTIME=<core>/runtime tsx --test task-argv.test.mts
import assert from 'node:assert/strict';
import path from 'node:path';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';
import {taskArgv} from './task-argv.mjs';

const runtime = process.env.CORE_RUNTIME;
assert.ok(runtime && path.isAbsolute(runtime), 'CORE_RUNTIME must be an absolute runtime path');
const load = (name: string) => import(pathToFileURL(path.join(runtime, 'src/bin', name)).href);
const {readStartupCliFlags} = await load('startup-selection.ts');
const {stripRoutingFlags} = await load('route.ts');
const {tokenizeCliOptionRegion} = await load('cli-option-region.ts');

const TASK = 'Say Done. Do not invoke any tool.';
const CONFIG = '/gate/cli-four/config.toml';
const CLI = '/gate/source/runtime/bin/agenc';
const argv = taskArgv({tripwire: '/t.cjs', calendar: '/c.cjs', cli: CLI, config: CONFIG, task: TASK});
// Node flags come before the CLI script; the CLI sees only what follows it.
const userArgv = (full: string[]) => full.slice(full.indexOf(CLI) + 1);

test('node preloads stay before the CLI script', () => {
  assert.deepEqual(argv.slice(0, 5), ['--require', '/t.cjs', '--require', '/c.cjs', CLI]);
});

test('successor argv selects Light, provider, model, config and permission mode', () => {
  const flags = readStartupCliFlags(['node', 'agenc', ...userArgv(argv)]);
  assert.equal(flags.lightMode, true);
  assert.equal(flags.provider, 'openai');
  assert.equal(flags.model, 'gpt-6-luna');
  assert.equal(flags.configPath, CONFIG);
  assert.equal(flags.permissionMode, 'default');
});

test('successor argv keeps -p in the option region and the prompt is exactly TASK', () => {
  const region = tokenizeCliOptionRegion(userArgv(argv));
  assert.equal(region.endedBy, 'delimiter');
  assert.equal(region.optionArgs[0], '-p');
  assert.deepEqual(region.promptArgs, [TASK]);
  assert.equal(stripRoutingFlags(userArgv(argv)).join(' ').trim(), TASK);
});

test('negative control: the v2 ordering loses Light and leaks flags into the prompt', () => {
  const v2 = ['-p', TASK, '--light', '--provider', 'openai', '--model', 'gpt-6-luna', '--config', CONFIG, '--permission-mode', 'default'];
  const flags = readStartupCliFlags(['node', 'agenc', ...v2]);
  assert.equal(flags.lightMode, undefined);
  assert.equal(flags.provider, undefined);
  assert.equal(flags.configPath, undefined);
  const prompt = stripRoutingFlags(v2).join(' ').trim();
  assert.notEqual(prompt, TASK);
  assert.ok(prompt.startsWith(TASK + ' --light --provider openai'));
});
