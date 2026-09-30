// Draft only until root execution approval. Four real, minimal local children.
// This proves channel glue, not authentic publication, daemon identity or money.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createDispatcher, PINS} from './dispatcher-v6.mjs';
import {supervise, daemonIdentityDigest} from './parent-lifecycle.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pinnedNode = '/Users/tetsuoarena/claude-agenc/node/n/versions/node/26.8.1/bin/node';
const childPath = fileURLToPath(new URL('./parent-dispatch-child.mjs', import.meta.url));
const limits = {readyMs: 2000, taskMs: 2000, stopMs: 1000, closeMs: 2000, killGraceMs: 1000};
const owned = [];
function launch(register, mode, acknowledgments) {
  // Register the actual returned object synchronously, before fallible work.
  const child = fork(childPath, [mode, JSON.stringify(acknowledgments)], {
    execPath: pinnedNode, execArgv: [], env: {},
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'json',
  });
  register(child);
  const record = {child, exited: false, closed: false, disconnected: false};
  owned.push(record);
  child.once('exit', () => {record.exited = true;});
  child.once('close', () => {record.closed = true;});
  child.once('disconnect', () => {record.disconnected = true;});
  return child;
}
function assertContained() {
  // A failed assertion stops the single sequential test: no next child launch.
  for (const record of owned) {
    assert.equal(record.exited, true);
    assert.equal(record.closed, true);
    assert.equal(record.disconnected, true);
    assert.equal(record.child.connected, false);
  }
}
function fixture(client) {
  const expected = {
    channel_id: `synthetic-${client}-channel`, protocol_id: 'ipc-glue-only',
    run_id: `synthetic-${client}-run`, root_turn_id: 'synthetic-root', client,
    binding_profile_id: client === 'light' ? 'light-luna-44aed-source-base-v2' : 'pi-luna-v0731-shared-v1',
    ...PINS, binding_contract_sha256: 'a'.repeat(64), max_publications: 2,
  };
  const {max_publications: _, ...common} = expected;
  const acknowledgments = [1, 2].map(ordinal => ({
    ...common, kind: 'luna.capture.published.shared.v6', schema_version: 1,
    admission_id: `${expected.run_id}:${ordinal}`, call_ordinal: ordinal, publication_ordinal: ordinal,
    receipt_sha256: String(ordinal).repeat(64), request_body_sha256: 'b'.repeat(64),
    response_bytes_sha256: 'c'.repeat(64), response_byte_count: ordinal * 17,
  }));
  return {expected, acknowledgments};
}
const observations = {
  observeOutstandingOperations: () => false,
  // Explicit inert-fixture observation: no journal or writer is constructed.
  // This is not a reusable claim about a financial owner's real quiescence.
  observeJournalQuiescence: () => true,
};
function assertClean(lifecycle) {
  assert.equal(lifecycle.valid, true, JSON.stringify(lifecycle.issues));
  assert.equal(lifecycle.cleanup_complete, true);
  assert.equal(lifecycle.message_count, 1);
  const live = lifecycle.observeLifecycle();
  assert.equal(live.sticky_invalid, false);
  assert.equal(live.pending_operations, false);
  assert.equal(live.journal_quiescent, true);
  for (const child of [live.owner, live.task].filter(Boolean)) {
    assert.equal(child.spawned, true);
    assert.equal(child.exit_observed, true);
    assert.equal(child.closed, true);
    assert.equal(child.exit_code, 0);
    assert.equal(child.close_code, 0);
    assert.equal(child.invalid, false);
    assert.equal(child.kill_attempted, false);
  }
  assert.equal(live.owner.ipc_disconnected, true);
  return live;
}

test('four owned IPC children compose Pi/Light ACKs and refuse post-ACK invalid traffic', {timeout: 40000}, async () => {
  assert.equal(process.execPath, pinnedNode);
  assert.equal(hash(readFileSync(pinnedNode)), 'ebd2d552c7bebde593dd0390530963ad28de56bccde6ce387cdbe55fb0b6fb8e');
  for (const [name, digest] of Object.entries({
    'parent-lifecycle.mjs': 'e7d5b4bcaf5151cc5fec7c0128358891046af61fde863f3bc6cc3ec7e94793ad',
    'dispatcher-v6.mjs': 'c23fe62eca4767ae3d4d61b88266b33058b4eac2276a47f5075811b6f0d70c7d',
    'parent-dispatch-child.mjs': '7f0faca08bb0dd002e4e29d2dc135d0c7d00060f121777ea62fbfbae39cd8e87',
  })) assert.equal(hash(readFileSync(new URL(name, import.meta.url))), digest);

  const pi = fixture('pi'), piDispatcher = createDispatcher(pi.expected);
  const piLife = await supervise({arm: 'pi', expectedMessages: 1, ...limits, ...observations,
    spawnOwner: register => launch(register, 'pi-owner', pi.acknowledgments),
    dispatchOwnerMessage: piDispatcher.dispatch});
  assertContained();
  const piLive = assertClean(piLife);
  assert.equal(piLive.task, null);
  assert.equal(piLive.daemon_identity_sha256, null);
  assert.deepEqual(piDispatcher.finish().acknowledgments, pi.acknowledgments);
  assert.equal(piDispatcher.snapshot().finalization_authorized, false);

  const light = fixture('light'), lightDispatcher = createDispatcher(light.expected);
  let owner, releasePublications, publishSendFailed = false;
  const publications = new Promise(resolve => {releasePublications = resolve;});
  // Deliberately injected identity, not a real Core sidecar/socket/PID proof.
  const build = {runtimeVersion: 'synthetic', commit: 'synthetic', buildTime: 'synthetic'};
  const identity = () => ({pid: owner.pid, instanceId: 'synthetic-instance', processStart: 'synthetic-start', ...build});
  const lightLife = await supervise({arm: 'light', expectedMessages: 1, ...limits, ...observations,
    expectedBuild: build,
    spawnOwner: register => {owner = launch(register, 'light-owner', light.acknowledgments);},
    spawnTask: register => {owner.send('publish', error => {
      if (error) {publishSendFailed = true; releasePublications();}
    });
      return launch(register, 'task-noop', []);},
    dispatchOwnerMessage(message, context) {
      const tag = lightDispatcher.dispatch(message, context);
      if (lightDispatcher.snapshot().acknowledgments.length === 2) releasePublications();
      return tag;
    },
    identityAdapter: {readSidecar: async () => identity(), readProcessStart: async () => identity().processStart,
      requestAuthenticatedIdentity: async () => identity()},
    requestShutdown: async bound => {
      await publications;
      await new Promise((resolve, reject) => owner.send('shutdown', error => error ? reject(error) : resolve()));
      return {shuttingDown: true, instanceId: bound.instanceId};
    },
  });
  assertContained();
  assert.equal(publishSendFailed, false);
  const lightLive = assertClean(lightLife);
  assert.equal(lightLive.task.ipc_disconnected, null);
  assert.equal(lightLive.daemon_identity_sha256, daemonIdentityDigest(identity()));
  assert.equal(lightLive.shutdown_acknowledged, true);
  assert.deepEqual(lightDispatcher.finish().acknowledgments, light.acknowledgments);
  assert.equal(lightDispatcher.snapshot().finalization_authorized, false);

  const negative = fixture('pi'), rejected = createDispatcher(negative.expected);
  const negativeLife = await supervise({arm: 'pi', expectedMessages: 1, ...limits, ...observations,
    spawnOwner: register => launch(register, 'late-invalid', negative.acknowledgments),
    dispatchOwnerMessage: rejected.dispatch});
  assertContained();
  assert.equal(negativeLife.cleanup_complete, true);
  assert.equal(negativeLife.valid, false);
  assert(negativeLife.issues.includes('invalid_owner_dispatch'));
  const negativeLive = negativeLife.observeLifecycle();
  assert.equal(negativeLive.owner.invalid, true);
  assert.equal(negativeLive.sticky_invalid, true);
  assert.equal(negativeLive.pending_operations, false);
  const refused = rejected.finish();
  assert.deepEqual(refused.acknowledgments, negative.acknowledgments);
  assert.equal(refused.failed, true);
  assert.equal(refused.finalization_authorized, false);
  assert.equal(owned.length, 4);
});
