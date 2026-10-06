import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'

it('loads the same Chalk instance synchronously only for a printable resume hint', () => {
  // Exercise the actual private function in a fresh native Node process.
  // Only its terminal/session dependencies are replaced with deterministic values.
  const path = resolve(import.meta.dirname, '../../src/utils/gracefulShutdown.ts')
  const source = readFileSync(path, 'utf8')
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  const hint = ast.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'printResumeHint')
  if (!hint) throw new Error('printResumeHint not found')
  const body = ts.transpile(hint.getText(ast), { target: ts.ScriptTarget.ESNext })
  const script = String.raw`
    import assert from 'node:assert/strict';
    import { createRequire, registerHooks } from 'node:module';
    let chalkResolutions = 0;
    registerHooks({ resolve(specifier, context, next) {
      if (specifier === 'chalk') chalkResolutions++;
      return next(specifier, context);
    }});
    const writes = [];
    const writeSync = (fd, text) => { assert.equal(fd, 1); writes.push(text); };
    let interactive = false, disabled = false, present = true, title;
    const getIsInteractive = () => interactive;
    const isSessionPersistenceDisabled = () => disabled;
    const getSessionId = () => 'session-1';
    const sessionIdExists = id => { assert.equal(id, 'session-1'); return present; };
    const getCurrentSessionTitle = () => title;
    let resumeHintPrinted = false;
    ${body}
    assert.equal(chalkResolutions, 0);
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    interactive = true; printResumeHint();
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    interactive = false; printResumeHint();
    interactive = true; disabled = true; printResumeHint();
    disabled = false; present = false; printResumeHint();
    assert.equal(chalkResolutions, 0);
    assert.deepEqual(writes, []);
    present = true;
    assert.equal(printResumeHint(), undefined);
    assert.equal(chalkResolutions, 1);
    const chalk = (await import('chalk')).default;
    assert.equal(writes[0], chalk.dim('\nResume this session with:\nagenc --resume session-1\n'));
    printResumeHint();
    assert.equal(writes.length, 1);
    const oldLevel = chalk.level;
    chalk.level = 3;
    resumeHintPrinted = false;
    assert.equal(printResumeHint(), undefined);
    assert.equal(writes[1], chalk.dim('\nResume this session with:\nagenc --resume session-1\n'));
    assert.ok(writes[1].includes('\u001b['));
    chalk.level = oldLevel;
  `
  expect(execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: resolve(import.meta.dirname, '../..'), encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '' },
  })).toBe('')
})
