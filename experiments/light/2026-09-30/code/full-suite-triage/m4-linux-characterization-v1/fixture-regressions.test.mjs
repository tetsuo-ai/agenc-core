import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
const runtime = '/private/tmp/light-takeover/startup-core/runtime';
const require = createRequire(join(runtime, 'package.json'));
const ts = require('typescript');
const revision = process.env.M4_FIXTURE_SOURCE_REVISION;
if (revision !== undefined && !/^[a-f0-9]{40}$/.test(revision)) throw new Error('full revision required');
const text = revision === undefined
  ? readFileSync(join(runtime, 'tests/durability/fixtures/m4-failure-matrix-child.ts'), 'utf8')
  : execFileSync('git', ['-C', runtime, 'show', `${revision}:runtime/tests/durability/fixtures/m4-failure-matrix-child.ts`],
    { encoding: 'utf8', maxBuffer: 1048576 });
const ast = ts.createSourceFile('fixture.ts', text, ts.ScriptTarget.ESNext, true);
const canonical = ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === 'canonicalEvents');
assert.equal(canonical.length, 1);
const compile = source => ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext,
} }).outputText;
const loadEvents = rows => new Function('walkFiles', 'readJsonLines',
  compile(canonical[0].getText(ast)) + '\nreturn canonicalEvents;')(
    () => Object.keys(rows), path => rows[path]);
test('malformed canonical coordinates retain the real source path, not ReferenceError', () => {
  const fn = loadEvents({ '/synthetic/rollout-one.jsonl': [{ type: 'event_msg', payload: { seq: 1 } }] });
  assert.throws(() => fn({ home: '/synthetic' }), error => error.constructor === Error &&
    error.message === 'canonical event lacks durable coordinates in /synthetic/rollout-one.jsonl');
});
test('existing canonical filtering and global sequence ordering remain unchanged', () => {
  const first = { seq: 1, eventId: 'event-1' }, second = { seq: 2, eventId: 'event-2' };
  const fn = loadEvents({ '/synthetic/ignored.jsonl': [{ type: 'event_msg', payload: null }],
    '/synthetic/rollout-one.jsonl': [{ type: 'metadata' }, { type: 'event_msg', payload: second }],
    '/synthetic/rollout-two.jsonl': [null, { type: 'event_msg', payload: first }] });
  assert.deepEqual(fn({ home: '/synthetic' }), [first, second]);
});
test('missing or malformed durable coordinates still fail closed', () => {
  for (const payload of [null, 1, {}, { seq: 1, eventId: '' }, { seq: 1.5, eventId: 'x' }]) {
    const fn = loadEvents({ '/synthetic/rollout-one.jsonl': [{ type: 'event_msg', payload }] });
    assert.throws(() => fn({ home: '/synthetic' }), /canonical event lacks durable coordinates/);
  }
});
test('actual source projection retains PersistedAdmissionRecord.jobId in JSON', () => {
  const expressions = [];
  function visit(node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'jobs') expressions.push(node.initializer.getText(ast));
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(expressions.length, 1);
  const project = new Function(compile(`function project(jobs: any[]) { return ${expressions[0]}; }`) + '\nreturn project;')();
  assert.deepEqual(JSON.parse(JSON.stringify(project([{ jobId: 'job-fixture', status: 'queued' }]))),
    [{ id: 'job-fixture', status: 'queued' }]);
});
