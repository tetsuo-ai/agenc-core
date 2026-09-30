// DRAFT: coordinator must review before executing this single sequential test.
// Three actual owned fixture children, zero Core/Pi/CLI/provider execution.
// Reuse direct-owner lifecycle solely for containment, NOT as a Pi/daemon claim.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fork} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const childPath = path.join(here, 'callback-observer-child.mjs');
const childHash = '0e4d4b5b3906c89a34488682ddd0ebb358d1d8ba3a8e82a2eb0fd19729f28e84';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
// This tiny entrypoint is pinned before importing its inert source selection.
assert.equal(hash(fs.readFileSync(childPath)), childHash);
const {HERE, FAIR, NODE, PYTHON, PYTHON_SHA, CODEC, PINS, sha, readBounded, verifySelection} = await import('./callback-observer-child.mjs');
verifySelection();
assert.equal(HERE, here);
const {preparedSemanticDigest: digest} = await import(pathToFileURL(CODEC).href);
const {supervise, spawnWithLog} = await import('./parent-lifecycle.mjs');
const {readPublisherBinding} = await import('./publisher-record-parent.mjs');
const {PINS: publicationPins} = await import('./dispatcher-v6.mjs');
const {financialPolicyId} = await import('../luna-finance-mode-v2/journal.mjs');
const {reconcileAttempt} = await import('../shared-attempt-v1/reconcile.mjs');
const TASK = 'Say Done. Do not invoke any tool.';
const profile = 'light-luna-44aed-source-base-v2';
const producers = ['plan_mode', 'verify_plan_reminder', 'auto_mode', 'swarm_mode',
  'deferred_tools_delta', 'requested_tools', 'agent_listing_delta', 'mcp_instructions_delta',
  'date_change', 'instruction_update', 'critical_reminder', 'output_style', 'relevant_memories',
  'changed_files', 'lsp_diagnostics', 'agent_mentions', 'mcp_resources', 'file_mentions', 'skill_listing'];
const identity = name => {
  const st = fs.statSync(name, {bigint: true}); return {dev: String(st.dev), ino: String(st.ino)};
};
function canonical(value) {
  const encode = item => {
    if (Array.isArray(item)) return '[' + item.map(encode).join(',') + ']';
    if (item !== null && typeof item === 'object') return '{' + Object.keys(item).sort()
      .map(key => JSON.stringify(key) + ':' + encode(item[key])).join(',') + '}';
    return JSON.stringify(item);
  };
  return Buffer.from(encode(value).replace(/[\u007f-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')));
}
const write = (name, bytes) => fs.writeFileSync(name, bytes, {flag: 'wx', mode: 0o600});
const json = name => JSON.parse(readBounded(name));

function setup(label, spendPolicy, variant) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-callback-observer-')));
  fs.chmodSync(root, 0o700);
  const runDirectory = path.join(root, 'run'), financialRoot = path.join(root, 'financial');
  fs.mkdirSync(runDirectory, {mode: 0o700}); fs.mkdirSync(financialRoot, {mode: 0o700});
  const ledger = path.join(financialRoot, 'luna-api-ledger.jsonl'); write(ledger, '');
  const r = identity(financialRoot), j = identity(ledger);
  const selected = json(path.join(FAIR, 'current-base-binding-v2/source-pins.json'));
  const deployed = Object.fromEntries(Object.entries(selected).map(([name, pin]) => ['runtime/' + name, pin]));
  const instructions = 'Synthetic independent static instructions.\n\nSynthetic independent dynamic suffix.';
  // Deliberate unit recipe, not a canonical producer inventory claim. No live
  // request, prepared report or received ACK exists while expectations are made.
  const material = {version: 1, task: TASK, instructions, tools: [],
    assembly: {schemaVersion: 1, collection: 'ordinary', inventory: 'complete', unknownReason: null,
      outcomes: producers.map(producer => ({producer, status: 'fulfilled', outputCount: 0, outputKinds: []}))},
    semantic: {instructionsDigest: digest(instructions),
      messages: [{role: 'user', contentForm: 'text', digest: digest({role: 'user', content: TASK})}], tools: [],
      fields: [{field: 'lightReasoningEffort', present: true, digest: digest(undefined)},
        {field: 'openaiReasoningReplay', present: true, digest: digest(true)}]},
    wireTemplate: {model: 'gpt-6-luna', stream: true, store: false,
      instructions: 'Synthetic independent static instructions.',
      input: [{type: 'message', role: 'user', content: [{type: 'input_text', text: TASK}]},
        {type: 'message', role: 'system', content: [{type: 'input_text', text: 'Synthetic independent dynamic suffix.'}]}],
      tools: [], max_output_tokens: 8192, reasoning: {effort: 'low', summary: 'auto'},
      include: ['reasoning.encrypted_content'], parallel_tool_calls: true},
    generatedSlots: ['conversationId/prompt_cache_key', 'rootTurnId', 'managedRequestId', 'user-initial-threadId'],
    equivalence: 'fresh-empty-resource-only', selectedOrWireObserved: false};
  const input = {material, independentMaterialDigest: digest(material),
    protocolId: 'synthetic-callback-observer-v1', financialRunId: 'synthetic-run', publicationChannelId: 'synthetic-channel',
    runDirectory, runDirectoryIdentity: identity(runDirectory), financialRoot,
    financialInventory: {rootDev: r.dev, rootIno: r.ino, journalDev: j.dev, journalIno: j.ino,
      prefixBytes: 0, prefixSha256: sha('')}, spendPolicy, financialPolicyId: financialPolicyId(spendPolicy),
    deployedSourcePins: deployed, clientArtifactSha256: sha('synthetic callback only; no client artifact'),
    configurationSha256: sha('synthetic one-call fixture; not CLI configuration'),
    pythonPath: PYTHON, pythonSha256: PYTHON_SHA, fairRoot: FAIR};
  const binding = {conversationId: 'synthetic-conversation', rootTurnId: 'synthetic-root',
    managedRequestId: '11111111-1111-4111-8111-111111111111', admissionRunId: 'synthetic-core-admission',
    independentMaterialDigest: input.independentMaterialDigest,
    wire: {...material.wireTemplate, prompt_cache_key: 'synthetic-conversation'}};
  const expected = {binding_profile_id: profile, protocol_id: input.protocolId, run_id: input.financialRunId,
    publication_channel_id: input.publicationChannelId, independent_material_digest: input.independentMaterialDigest,
    task_prompt_sha256: sha(TASK), client_artifact_sha256: input.clientArtifactSha256,
    configuration_sha256: input.configurationSha256, source_inventory_sha256: sha(canonical(deployed)), ...publicationPins};
  const specPath = path.join(runDirectory, 'callback-observer-spec.json');
  const spec = Buffer.from(JSON.stringify({input, binding, variant})); write(specPath, spec);
  write(path.join(root, 'selection.json'), JSON.stringify({scope: 'synthetic-callback-observer-only', label,
    child_sha256: childHash, source_pins: PINS, node: NODE, python: PYTHON, python_sha256: PYTHON_SHA,
    material_digest: input.independentMaterialDigest, declaration_ids_are_synthetic: true,
    actual_cli: false, linux_validation: false, provider_calls: false}) + '\n');
  return {root, input, binding, expected, label, variant, specPath, specHash: sha(spec), ledger, runDirectory};
}

let sequenceBlocked = false;
async function run(t) {
  assert.equal(sequenceBlocked, false, 'do not continue after uncertain owned-child cleanup');
  let owned = null, joined = null;
  const readPublisher = () => readPublisherBinding({runDirectory: t.runDirectory,
    runDirectoryIdentity: t.input.runDirectoryIdentity, expected: t.expected});
  const lifecycle = await supervise({
    // 'pi' is only the existing direct-owner topology. Metadata remains Light;
    // this projection is never submitted as a Light daemon/finalizer proof.
    arm: 'pi', expectedMessages: 0, readyMs: 5000, taskMs: 20000,
    stopMs: 1000, closeMs: 3000, killGraceMs: 1000,
    observeOutstandingOperations: () => owned === null || !owned.closed,
    observeJournalQuiescence: () => owned?.closed === true && owned.disconnected &&
      !fs.existsSync(path.join(t.input.financialRoot, 'luna-api-admission.lock')),
    spawnOwner(register) {
      return spawnWithLog({
        openLog: () => fs.openSync(path.join(t.root, 'child.log'), 'wx', 0o600), closeLog: fd => fs.closeSync(fd),
        spawn: fd => fork(childPath, [t.specPath, t.specHash], {execPath: NODE, execArgv: ['--experimental-strip-types'],
          cwd: t.root, stdio: ['ignore', fd, fd, 'ipc'], serialization: 'json',
          env: {HOME: t.root, PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC',
            LUNA_LEDGER_ROOT: t.input.financialRoot, LUNA_RUN_DIR: t.runDirectory,
            LUNA_RUN_ID: t.input.financialRunId, LUNA_TASK_CALL_CAP: '1'}}),
        register(child) {
          register(child);
          owned = {child, exited: false, closed: false, disconnected: false};
          child.once('exit', () => {owned.exited = true;});
          child.once('close', () => {owned.closed = true;});
          child.once('disconnect', () => {owned.disconnected = true;});
        },
      });
    },
    dispatchOwnerMessage(message, owner) {
      // The strict lifecycle checks owner/spawn/live/channel first. Construct
      // expectations from the independently bound publisher BEFORE reading or
      // dispatching any ACK field. No initialization from received messages.
      joined ??= readPublisher();
      return joined.dispatcher.dispatch(message, owner);
    },
  });
  if (!owned?.exited || !owned.closed || !owned.disconnected || owned.child.connected !== false) sequenceBlocked = true;
  const live = lifecycle.observeLifecycle();
  write(path.join(t.root, 'parent-lifecycle.json'), JSON.stringify({
    scope: 'synthetic-direct-owner-not-client', lifecycle, live, sequenceBlocked}) + '\n');
  assert.equal(sequenceBlocked, false);
  assert.equal(lifecycle.cleanup_complete, true);
  assert.equal(lifecycle.valid, true, JSON.stringify(lifecycle.issues));
  assert.equal(lifecycle.message_count, 0);
  assert.equal(live.pending_operations, false); assert.equal(live.journal_quiescent, true);
  assert.equal(live.sticky_invalid, false); assert.equal(live.task, null);
  assert.equal(live.owner.kill_attempted, false); assert.equal(live.owner.exit_code, 0); assert.equal(live.owner.close_code, 0);
  assert.equal(live.owner.ipc_disconnected, true);
  // The refusal case has no publication message; independently validate the
  // successful publisher after close, not by inventing a substitute ACK.
  joined ??= readPublisher();
  const channel = joined.dispatcher.finish(), outcome = json(path.join(t.runDirectory, 'callback-observer-outcome.json'));
  const ledgerBytes = readBounded(t.ledger);
  const inventory = reconcileAttempt({ledgerBytes, acknowledgments: channel.acknowledgments,
    expected: {run_id: t.input.financialRunId, root_turn_id: joined.record.root_turn_id,
      client: 'light', binding_profile_id: profile, protocol_id: t.input.protocolId,
      channel_id: t.input.publicationChannelId, financial_policy_id: t.input.financialPolicyId,
      ...publicationPins, binding_contract_sha256: joined.record.contract_sha256}});
  write(path.join(t.root, 'parent-artifacts.json'), JSON.stringify({label: t.label, outcome, inventory,
    record_sha256: joined.record_sha256, channel, finalization_authorized: false}) + '\n');
  assert.equal(channel.failed, false); assert.equal(channel.finalization_authorized, false);
  assert.equal(inventory.finalizationAuthorized, false);
  assert.equal(outcome.scope, 'synthetic-callback-observer-only'); assert.equal(outcome.forbiddenCalls, 0);
  assert.equal(outcome.callbacks.published, true); assert.equal(outcome.callbacks.failed, false);
  assert.equal(outcome.callbacks.recordHash, joined.record_sha256);
  assert.equal(outcome.callbacks.metadataHash, joined.record.metadata_sha256);
  assert.equal(fs.existsSync(path.join(t.input.financialRoot, 'luna-api-stop.json')), false);
  assert.equal(fs.existsSync(path.join(t.input.financialRoot, 'luna-api-admission.lock')), false);

  if (t.variant === 'changed-task') {
    assert.equal(outcome.refused, true); assert.equal(outcome.bodyEof, false); assert.equal(outcome.callbacks.fetched, false);
    assert.deepEqual(outcome.helperResults, [{kind: 'policy', verified: true, reason: null},
      {kind: 'binding', verified: null, reason: 'task_prompt_hash_mismatch'}]);
    assert.equal(ledgerBytes.length, 0); assert.equal(inventory.admittedCalls, 0); assert.equal(inventory.settledCalls, 0);
    assert.equal(inventory.completeUsage, false); assert.equal(inventory.chargeTotalNanodollars, null);
    assert.equal(channel.acknowledgments.length, 0);
    assert.deepEqual(fs.readdirSync(t.runDirectory).filter(name => name.startsWith('capture-')), []);
  } else {
    assert.equal(outcome.refused, false); assert.equal(outcome.bodyEof, true); assert.equal(outcome.callbacks.fetched, true);
    assert.deepEqual(outcome.helperResults, [{kind: 'policy', verified: true, reason: null}, {kind: 'binding', verified: true, reason: null}]);
    assert.equal(inventory.admittedCalls, 1); assert.equal(inventory.settledCalls, 1); assert.equal(inventory.knownCalls, 1);
    assert.equal(inventory.unknownHoldCalls, 0); assert.equal(inventory.unsettledCalls, 0);
    assert.equal(inventory.completeUsage, true); assert.equal(inventory.chargeTotalNanodollars, '20000');
    assert.equal(inventory.journalExposureNanodollars, '20000'); assert.equal(inventory.ackInventoryComplete, true);
    assert.deepEqual(inventory.tokenTotals, {input: '100', output: '20', cached: '0', uncached: '100'});
    assert.equal(channel.acknowledgments.length, 1);
    const ack = channel.acknowledgments[0], receiptBytes = readBounded(path.join(t.runDirectory, 'capture-receipt-001.json'), 256 * 1024);
    const requestBytes = readBounded(path.join(t.runDirectory, 'capture-request-001.json'));
    const responseBytes = readBounded(path.join(t.runDirectory, 'capture-response-001.sse'));
    const receipt = JSON.parse(receiptBytes);
    assert.equal(sha(receiptBytes), ack.receipt_sha256); assert.equal(sha(requestBytes), ack.request_body_sha256);
    assert.equal(sha(responseBytes), ack.response_bytes_sha256); assert.equal(responseBytes.length, ack.response_byte_count);
    assert.deepEqual(requestBytes, Buffer.from(JSON.stringify(t.binding.wire)));
    assert.equal(sha(responseBytes), outcome.responseSha256);
    for (const key of ['protocol_id', 'run_id', 'root_turn_id', 'client', 'binding_profile_id',
      'admission_id', 'call_ordinal', 'request_body_sha256', 'response_bytes_sha256', 'response_byte_count',
      'observer_source_sha256', 'installed_adapter_sha256', 'binding_source_sha256', 'binding_contract_sha256']) {
      assert.deepEqual(receipt[key], ack[key]);
    }
    assert.equal(receipt.schema_version, 2); assert.equal(receipt.task_prompt_sha256, t.expected.task_prompt_sha256);
    assert.equal(receipt.initial_request, true); assert.equal(receipt.initial_binding_verified, true);
    assert.equal(receipt.request_role, 'root'); assert.equal(receipt.prior_root_generations, 0);
    assert.equal(receipt.transport_outcome, 'eof'); assert.equal(receipt.http_status, 200);
    assert.equal(receipt.response_content_type, 'text/event-stream'); assert.equal(receipt.requested_stream, true);
    assert.equal(receipt.downstream_delivery_failed, false); assert.equal(receipt.capture_write_complete, true);
  }
  // No returned file hash or synthetic lifecycle projection is a score token.
  return t.root;
}

test('actual observer joins callback publisher, financial EOF and genuine owned ACK in two modes; task drift refuses pre-admission', {timeout: 90000}, async () => {
  const completedRoots = [];
  for (const [label, spendPolicy, variant] of [
    ['positive-cap', {mode: 'positive_cap', capUsd: '0.1'}, 'healthy'],
    ['credit-exhaustion', {mode: 'credit_exhaustion'}, 'healthy'],
    ['changed-task', {mode: 'credit_exhaustion'}, 'changed-task'],
  ]) {
    const t = setup(label, spendPolicy, variant);
    // Preserve the exact selected private root even when the first assertion fails.
    console.log(JSON.stringify({scope: 'synthetic-callback-observer', label, root: t.root}));
    completedRoots.push(await run(t));
  }
  assert.equal(completedRoots.length, 3);
});
