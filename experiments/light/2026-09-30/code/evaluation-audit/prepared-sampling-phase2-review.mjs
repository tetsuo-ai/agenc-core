import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  buildPreparedSamplingEvidence,
  preparedSemanticDigest,
  validatePreparedSamplingEvidence,
} from '/private/tmp/light-takeover/startup-core/runtime/src/session/prepared-sampling-evidence.ts';
import { buildAttachmentAssemblyEvidence } from '/private/tmp/light-takeover/startup-core/runtime/src/prompts/attachments/assembly-evidence.ts';

const id = '00000000-0000-4000-8000-000000000001';
const request = () => ({ managedRequestId: id, input: [{ role: 'user', content: 'PRIVATE_TASK' }],
  tools: [], baseInstructions: 'PRIVATE_BASE', parallelToolCalls: false });
const facts = () => ({ turnId: 'PRIVATE_TURN', rootHumanTurn: { turnId: 'PRIVATE_TURN', text: 'PRIVATE_TASK' },
  sourceMessageCount: 1, preAttachmentMessageCount: 1, retainedAttachmentBlocks: 0,
  retainedAttachmentMessages: 0, rawAttachmentOutputs: 0,
  assembly: buildAttachmentAssemblyEvidence('ordinary', ['date_change'], [{ status: 'fulfilled', value: [] }]) });

test('independent literal tagged-codec vector and structural distinctions', () => {
  const encoded = 'prepared-semantic-v1:["object",[["a",["array",[["undefined"],["null"],["boolean",false]]]],["z",["number","-0"]]]]';
  assert.equal(preparedSemanticDigest({ z: -0, a: [undefined, null, false] }), createHash('sha256').update(encoded).digest('hex'));
  const distinct = [[], {}, ['a', 1], { a: 1 }, { a: undefined }, { a: null }, { a: 0 }, { a: -0 }];
  assert.equal(new Set(distinct.map(preparedSemanticDigest)).size, distinct.length);
});

test('canonical ID accepts only exact supplied UUID shape and omits invalid raw values', () => {
  assert.equal(buildPreparedSamplingEvidence(request(), facts()).managedRequestId, id);
  for (const bad of [undefined, null, 1, '', id + '\n', id + '\r', id + '\r\n', id + '\u2028', id + '\u2029', id.replace('-4000-', '-5000-'), id.replace('-8000-', '-7000-'), 'PRIVATE_ID']) {
    const report = buildPreparedSamplingEvidence({ ...request(), managedRequestId: bad }, facts());
    assert.equal(report.inventory, 'unknown');
    assert.equal(report.managedRequestId, null);
    assert.equal(report.details, null);
  }
});

test('request order and optional-property presence remain visible without raw payloads', () => {
  const base = request();
  base.input.push({ role: 'assistant', content: 'PRIVATE_ANSWER' });
  const ordinary = buildPreparedSamplingEvidence(base, facts());
  const reversed = buildPreparedSamplingEvidence({ ...base, input: [...base.input].reverse() }, facts());
  assert.notEqual(ordinary.details.requestDigest, reversed.details.requestDigest);
  assert.deepEqual(ordinary.details.messages.map(m => m.digest).reverse(), reversed.details.messages.map(m => m.digest));
  for (const field of ['toolChoice', 'contextWindowTokens', 'maxOutputTokens', 'skipCacheWrite', 'lightReasoningEffort', 'openaiReasoningReplay']) {
    const explicit = buildPreparedSamplingEvidence({ ...base, [field]: undefined }, facts());
    assert.notEqual(ordinary.details.requestDigest, explicit.details.requestDigest);
    assert.equal(ordinary.details.fields.find(f => f.field === field).present, false);
    assert.equal(explicit.details.fields.find(f => f.field === field).present, true);
  }
  assert.ok(!JSON.stringify(ordinary).includes('PRIVATE_'));
});

test('canonical facts are detached and every nested report object is frozen', () => {
  const inputFacts = facts();
  const report = buildPreparedSamplingEvidence(request(), inputFacts);
  const walk = value => {
    if (value && typeof value === 'object') {
      assert.ok(Object.isFrozen(value));
      for (const child of Object.values(value)) walk(child);
    }
  };
  walk(report);
  assert.notEqual(report.details.assembly, inputFacts.assembly);
  assert.notEqual(report.details.assembly.outcomes, inputFacts.assembly.outcomes);
  assert.notEqual(report.details.assembly.outcomes[0], inputFacts.assembly.outcomes[0]);
  inputFacts.rootHumanTurn.text = 'changed';
  assert.equal(report.details.root.textDigest, preparedSemanticDigest('PRIVATE_TASK'));
});

test('unsupported shape/count/cycle evidence is unknown, never a partial complete inventory', () => {
  const tooMany = { ...request(), input: Array.from({ length: 4097 }, () => ({ role: 'user', content: '' })) };
  for (const value of [tooMany, { ...request(), futureSetting: true }, { ...request(), input: [{ role: 'user', content: [{ type: 'future_part', content: 'PRIVATE_PART' }] }] }]) {
    assert.deepEqual(buildPreparedSamplingEvidence(value, facts()).details, null);
    assert.equal(buildPreparedSamplingEvidence(value, facts()).inventory, 'unknown');
  }
  const circular = facts(); circular.cycle = circular;
  assert.equal(buildPreparedSamplingEvidence(request(), circular).inventory, 'unknown');
  for (const count of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(buildPreparedSamplingEvidence(request(), { ...facts(), rawAttachmentOutputs: count }).inventory, 'unknown');
  }
});

test('unknown semantic inventory preserves the trusted validator decision, not automatic authority', () => {
  const report = buildPreparedSamplingEvidence({ ...request(), futureSetting: 1 }, facts());
  let observed;
  assert.throws(() => validatePreparedSamplingEvidence(report, r => { observed = r; if (r.inventory !== 'complete') throw null; }, new AbortController().signal), { code: 'prepared_sampling_validation_failed' });
  assert.equal(observed, report);
});

test('callback Proxy return and thrown hostile object do not execute getters or traps', () => {
  const report = buildPreparedSamplingEvidence(request(), facts());
  let touched = 0;
  const hostile = new Proxy({}, { get() { touched++; throw null; }, ownKeys() { touched++; throw null; } });
  for (const callback of [() => hostile, () => { throw hostile; }]) {
    assert.throws(() => validatePreparedSamplingEvidence(report, callback, new AbortController().signal), { code: 'prepared_sampling_validation_failed' });
  }
  assert.equal(touched, 0);
});
