import assert from 'node:assert/strict';
import test from 'node:test';
import { createRecoveryFetch, CALL_ID, COMMAND, SENTINEL } from './recovery_fixture.mjs';

const request = overrides => ({ model: 'gpt-6-luna', stream: true,
  reasoning: { effort: 'low', summary: 'auto' }, max_output_tokens: 8192,
  include: ['reasoning.encrypted_content'], input: [{ role: 'user', content: 'synthetic-private-prompt' }],
  tools: [{ type: 'function', name: 'exec_command', parameters: {
    properties: { cmd: { type: 'string' } }, required: ['cmd'],
  } }], ...overrides });
const toolOutput = `${SENTINEL}\nFAILED (failures=1)\n\n[exec exit_code=1 wall_time=0.0100s tokens=30]`;
const next = effort => request({ reasoning: { effort, summary: 'auto' },
  input: [{ type: 'function_call_output', call_id: CALL_ID, output: toolOutput }] });
const invoke = (fetch, body) => fetch('https://api.openai.com/v1/responses', {
  method: 'POST', headers: { authorization: 'Bearer synthetic-private-header' }, body: JSON.stringify(body),
});
function fixture() {
  const records = []; let ran = false;
  return { records, ran: () => { ran = true; }, fetch: createRecoveryFetch({
    capture: row => records.push(row), validationRan: () => ran,
  }) };
}
const events = async response => (await response.text()).trim().split('\n\n').map(line => JSON.parse(line.slice(6)));

test('first response requests real canonical unittest command, not fabricated failure', async () => {
  const f = fixture(); const stream = await events(await invoke(f.fetch, request()));
  const item = stream.at(-1).response.output[0];
  assert.equal(item.type, 'function_call');assert.equal(item.name, 'exec_command');
  assert.equal(item.call_id, CALL_ID);assert.equal(JSON.parse(item.arguments).cmd, COMMAND);
  assert.equal(f.records[0].validation_process_ran, false);
  assert.equal(f.records[0].matching_tool_results, 0);
});
test('second request requires both actual-process marker and matching failed output', async () => {
  const f = fixture();await invoke(f.fetch, request());
  await assert.rejects(invoke(f.fetch, next('low')), /actual failed validation/);
});
test('process marker alone cannot substitute for canonical tool result', async () => {
  const f = fixture();await invoke(f.fetch, request());f.ran();
  await assert.rejects(invoke(f.fetch, request()), /actual failed validation/);
});
test('unrelated, successful, missing-executable and unfinished results cannot pass', async () => {
  for (const [call_id, output] of [
    ['unrelated-call', toolOutput],
    [CALL_ID, toolOutput.replace('exit_code=1', 'exit_code=0')],
    [CALL_ID, toolOutput.replace('exit_code=1', 'exit_code=127')],
    [CALL_ID, toolOutput.replace('exit_code=1', 'yielded=true')],
    [CALL_ID, toolOutput.replace(SENTINEL, 'unrelated failure')],
  ]) {
    const f = fixture();await invoke(f.fetch, request());f.ran();
    await assert.rejects(invoke(f.fetch, request({ input: [{ type: 'function_call_output', call_id, output }] })),
      /actual failed validation/);
  }
});
test('fixed and historical-medium actual request values are retained without rewriting', async () => {
  for (const effort of ['low','medium']) {
    const f = fixture();await invoke(f.fetch, request());f.ran();
    const stream = await events(await invoke(f.fetch, next(effort)));
    assert.equal(stream.at(-1).response.output[0].content[0].text, 'offline recovery validated');
    assert.deepEqual(f.records.map(row => row.effort), ['low', effort]);
    assert.equal(f.records[1].tool_exit_one, true);
    if (effort === 'medium') assert.notDeepEqual(f.records.map(row => row.effort), ['low','low']);
    await assert.rejects(invoke(f.fetch, next(effort)), /contract mismatch/);
  }
});
test('capture excludes prompts, raw tool output, headers and arbitrary setting strings', async () => {
  const f = fixture();await invoke(f.fetch, request({ reasoning: { effort: 'private-setting', summary: 'auto' } }));
  const encoded = JSON.stringify(f.records);
  for (const text of ['synthetic-private-prompt','synthetic-private-header','private-setting',COMMAND,SENTINEL]) {
    assert.equal(encoded.includes(text), false);
  }
  assert.equal(f.records[0].effort, 'invalid');
});
test('unknown origins, methods and tool schema are refused with no network fallback', async () => {
  const f = fixture();
  await assert.rejects(f.fetch('https://other.invalid/v1/responses', { method: 'POST' }), /unexpected origin/);
  await assert.rejects(f.fetch('http://api.openai.com/v1/responses', { method: 'POST' }), /unexpected origin/);
  await assert.rejects(f.fetch('https://api.openai.com/v1/responses', { method: 'GET' }), /endpoint or method/);
  await assert.rejects(invoke(f.fetch, request({ tools: [] })), /invalid initial state/);
});
