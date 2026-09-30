// Prospective financial composition successor; offline candidate, NOT installed.
// Historical observer and ledgers remain unchanged.
// Direct API observation and admission. No listener, forwarding server or key file.
import { checkFixedPolicy } from '../luna-policy-v2/policy_guard.mjs';
import { createFinancialOwner } from '../luna-finance-mode-v2/owner.mjs';
import { createFinancialTransport } from '../luna-financial-transport-v1/transport.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Prospective capture contract. This is NOT the observer used by old runners.
const ADAPTER_PIN = 'fceb751fd4f7b5e7dc41847fc5cc1eada663a31a368c15460fb31ec81b2c2323';
const BINDING_PIN = '3815c1fbbbbc9b2aaf23a9adcd469d5f5b0a2c4bb38ca42dfed9e826a491f87c';
const BRIDGE_PIN = 'c3c2afb87cc28c471cdd1a56f600d2f6beda4479cef27c42ccdcd8bac37ee0b4';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const identity = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,240}$/.test(value);
const need = condition => { if (!condition) throw new Error('Invalid prospective capture metadata or initial request'); };
function strictJson(bytes) {
  // Keep the exact bytes. Reject BOM rather than relying on decoder stripping.
  need(!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf));
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { need(false); }
  let at = 0;
  const space = () => { while (/[\x20\t\r\n]/.test(text[at] ?? '\0')) at++; };
  function string() {
    const start = at++; need(text[start] === '"');
    while (at < text.length) {
      if (text[at] === '\\') { at += 2; continue; }
      if (text[at++] === '"') {
        const decoded = JSON.parse(text.slice(start, at));
        // Iteration combines valid surrogate pairs; any remaining surrogate
        // code point is invalid, including escaped strings and object keys.
        need([...decoded].every(ch => {
          const cp = ch.codePointAt(0); return cp < 0xd800 || cp > 0xdfff;
        }));
        return decoded;
      }
    }
    need(false);
  }
  function value(depth = 0) {
    need(depth < 256); space(); const token = text[at];
    if (token === '"') return string();
    if (token === '{') {
      at++; space(); const out = Object.create(null), keys = new Set();
      if (text[at] === '}') { at++; return out; }
      for (;;) {
        space(); const key = string(); need(!keys.has(key)); keys.add(key);
        space(); need(text[at++] === ':'); out[key] = value(depth + 1); space();
        const end = text[at++]; if (end === '}') return out; need(end === ',');
      }
    }
    if (token === '[') {
      at++; space(); const out = [];
      if (text[at] === ']') { at++; return out; }
      for (;;) { out.push(value(depth + 1)); space(); const end = text[at++];
        if (end === ']') return out; need(end === ','); }
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(at));
    need(match); at += match[0].length; const out = JSON.parse(match[0]);
    need(typeof out !== 'number' || Number.isFinite(out)); return out;
  }
  const parsed = value(); space(); need(at === text.length);
  need(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)); return parsed;
}
function snapshotRequest(input, init) {
  // Restrict accepted input forms; never forward a mutable/re-coercible URL.
  need(typeof input === 'string' || input instanceof URL || input instanceof Request);
  const supplied = init === undefined ? {} : { ...init };
  const allowed = new Set(['method','headers','body','signal','credentials','cache',
    'redirect','referrer','referrerPolicy','integrity','keepalive','mode','duplex']);
  need(Object.keys(supplied).every(key => allowed.has(key)));
  const options = {};
  if (input instanceof Request) {
    // Node's new Request(existing, {}) resets referrerPolicy; carry accepted
    // original options explicitly rather than silently dropping that policy.
    for (const key of allowed) if (key !== 'body') options[key] = input[key];
  }
  Object.assign(options, supplied);
  if (options.body !== undefined && options.body !== null) {
    need(typeof options.body === 'string');
    const bytes = Buffer.from(options.body, 'utf8');
    need(new TextDecoder('utf-8', { fatal: true }).decode(bytes) === options.body);
  }
  // Request copies Headers/method/options synchronously, before any suspension.
  const snapshot = new Request(input instanceof URL ? input.href : input, options);
  // Own the original Request as well as its captured signal across active reads.
  // Node's dependent abort connection can disappear if the Request is collected.
  return { snapshot, request: input instanceof Request ? input : undefined,
    signal: options.signal ?? snapshot.signal };
}
async function boundedRequestBytes(snapshot, signal) {
  need(snapshot.body && !signal.aborted);
  const reader = snapshot.body.getReader(), chunks = [];
  let size = 0, chunkCount = 0, rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const abort = () => rejectAbort(new Error('Request preparation aborted'));
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      need(value instanceof Uint8Array && ++chunkCount <= 65536);
      size += value.byteLength;
      need(size <= 1024 * 1024);
      chunks.push(Buffer.from(value));
    }
    need(size > 0 && !signal.aborted);
    return Buffer.concat(chunks, size);
  } catch (cause) {
    // Cancellation is attempted, not proof that arbitrary external I/O ended.
    try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* preserve primary refusal */ }
    throw cause;
  } finally {
    signal.removeEventListener('abort', abort);
    try { reader.releaseLock(); } catch { /* pending cancellation is not retried */ }
  }
}
function regularBytes(filename, limit = Infinity) {
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const info = fs.fstatSync(fd); need(info.isFile() && info.size <= limit);
    const bytes = fs.readFileSync(fd); need(bytes.length <= limit); return bytes;
  }
  finally { fs.closeSync(fd); }
}
const observerHash = sha(regularBytes(fileURLToPath(import.meta.url)));
function runnerMetadata() {
  try {
    need(root && dir && identity(rid));
    const raw = regularBytes(process.env.LUNA_CAPTURE_METADATA);
    need(digest(process.env.LUNA_CAPTURE_METADATA_SHA256) && sha(raw) === process.env.LUNA_CAPTURE_METADATA_SHA256);
    const meta = strictJson(raw);
    const fields = ['schema_version', 'contract', 'protocol_id', 'run_id', 'root_turn_id', 'route',
      'task_prompt_sha256', 'observer_source_sha256', 'installed_adapter_sha256', 'installed_adapter_path', 'publication_channel_id', 'binding', 'fixed_policy', 'financial'];
    need(Object.keys(meta).sort().join() === fields.sort().join());
    need(meta.schema_version === 10 && meta.contract === 'prospective-current-source-finance-v5');
    need(identity(meta.publication_channel_id) && typeof process.send === 'function' && process.connected === true);
    need(identity(meta.protocol_id) && identity(meta.root_turn_id) && meta.run_id === rid && meta.route === 'openai-direct');
    need(digest(meta.task_prompt_sha256) && meta.observer_source_sha256 === observerHash);
    need(meta.installed_adapter_sha256 === ADAPTER_PIN && path.isAbsolute(meta.installed_adapter_path));
    need(sha(regularBytes(meta.installed_adapter_path)) === ADAPTER_PIN);
    const binding = meta.binding;
    need(binding && typeof binding === 'object' && !Array.isArray(binding));
    need(Object.keys(binding).sort().join() === ['contract_path', 'expected', 'deployed_source_pins',
      'binding_source_sha256', 'bridge_source_sha256', 'python_path', 'python_sha256'].sort().join());
    need(binding.binding_source_sha256 === BINDING_PIN && binding.bridge_source_sha256 === BRIDGE_PIN);
    need(binding.expected && typeof binding.expected === 'object' && !Array.isArray(binding.expected));
    for (const field of ['protocol_id', 'run_id', 'root_turn_id', 'route', 'task_prompt_sha256']) {
      need(binding.expected[field] === meta[field]);
    }
    need(digest(binding.expected.contract_sha256) && path.isAbsolute(binding.contract_path));
    need(path.isAbsolute(binding.python_path) && digest(binding.python_sha256));
    need(fs.realpathSync(binding.python_path) === binding.python_path);
    // Trusted interpreter/deployment closure remains an external prerequisite.
    need(sha(regularBytes(binding.python_path, 256 * 1024 * 1024)) === binding.python_sha256);
    const contractBytes = regularBytes(binding.contract_path, 256 * 1024);
    need(contractBytes.length <= 256 * 1024 && sha(contractBytes) === binding.expected.contract_sha256);
    const bridgeBytes = regularBytes(path.join(HERE, '../current-base-binding-v2/bridge.py'), 256 * 1024);
    need(sha(bridgeBytes) === BRIDGE_PIN);
    need(sha(regularBytes(path.join(HERE, '../current-base-binding-v2/binding.py'))) === BINDING_PIN);
    // Private byte snapshots survive asynchronous body reading without rereads.
    meta.bindingContractBytes = contractBytes;
    meta.bindingBridgeBytes = bridgeBytes;
    meta.metadataSha256 = sha(raw);
    return meta;
  } catch { throw new Error('Invalid prospective capture metadata or initial request'); }
}
function bindInitial(raw, meta) {
  need(raw.length <= 1024 * 1024);
  const binding = meta.binding;
  const payload = Buffer.from(JSON.stringify({ request_base64: raw.toString('base64'),
    contract_base64: meta.bindingContractBytes.toString('base64'), expected: binding.expected,
    deployed_source_pins: binding.deployed_source_pins,
    admission: { run_id: rid, root_turn_id: meta.root_turn_id, admission_id: `${rid}:1`,
      call_ordinal: 1, prior_root_generations: 0, initial_request: true, request_role: 'root' },
  }));
  need(payload.length <= 2 * 1024 * 1024);
  // Compile exactly the pinned snapshot, not an import cache or second source
  // read. Isolated Python sees no caller env/credentials/site hooks. No shell.
  const code = `__file__ = ${JSON.stringify(path.join(HERE, '../current-base-binding-v2/bridge.py'))}\n` + meta.bindingBridgeBytes.toString('utf8');
  const result = spawnSync(binding.python_path, ['-I', '-S', '-B', '-c', code], {
    input: payload, env: { LANG: 'C.UTF-8' }, cwd: HERE,
    timeout: 2000, killSignal: 'SIGKILL', maxBuffer: 16384,
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  need(!result.error && result.status === 0 && result.signal === null && result.stderr.length === 0);
  const verified = strictJson(result.stdout);
  need(verified.binding_verified === true && verified.unknown_reason === null &&
    verified.request_body_sha256 === sha(raw) && verified.contract_sha256 === binding.expected.contract_sha256 &&
    verified.task_prompt_sha256 === meta.task_prompt_sha256 && verified.call_ordinal === 1 &&
    verified.run_id === rid && verified.root_turn_id === meta.root_turn_id && verified.route === meta.route);
}
function syncDir() {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function writeAll(fd, bytes) {
  for (let offset = 0; offset < bytes.length;) {
    const count = fs.writeSync(fd, bytes, offset, bytes.length - offset);
    if (!Number.isInteger(count) || count <= 0) throw new Error('Capture write incomplete');
    offset += count;
  }
}
function durableExclusive(name, bytes) {
  const fd = fs.openSync(path.join(dir, name), 'wx', 0o600);
  try { writeAll(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  syncDir();
}
function publishReceipt(name, bytes) {
  const pending = name + '.pending';
  const target = path.join(dir, name);
  let published = false;
  try {
    durableExclusive(pending, bytes);
    // Same-filesystem hard-link publication is atomic and refuses replacement.
    fs.linkSync(path.join(dir, pending), target); published = true;
    syncDir();
  } catch (error) {
    if (published) {
      try { fs.unlinkSync(target); syncDir(); } catch { /* Inventory must fail closed on I/O uncertainty. */ }
    }
    throw error;
  }
}
function capture(meta, n, raw, body) {
  const suffix = String(n).padStart(3, '0');
  const hash = crypto.createHash('sha256');
  let count = 0, fd, healthy = true, complete = false;
  // Optional scoring artifacts MUST NOT influence financial settlement/send.
  try {
    durableExclusive(`capture-request-${suffix}.json`, Buffer.from(raw));
    fd = fs.openSync(path.join(dir, `capture-response-${suffix}.sse`), 'wx', 0o600);
  } catch { healthy = false; }
  return {
    add(bytes) {
      hash.update(bytes); count += bytes.byteLength;
      if (fd !== undefined && healthy) {
        try { writeAll(fd, bytes); } catch { healthy = false; }
      }
    },
    finish(outcome, status, contentType, deliveryFailed, captureFailed) {
      if (complete) return; complete = true;
      if (captureFailed) healthy = false;
      try {
        if (fd !== undefined) {
          try { fs.fsyncSync(fd); } catch { healthy = false; }
          try { fs.closeSync(fd); } catch { healthy = false; }
          fd = undefined;
        } else healthy = false;
        try { syncDir(); } catch { healthy = false; }
        const receipt = {
          schema_version: 2, protocol_id: meta.protocol_id, run_id: rid, root_turn_id: meta.root_turn_id,
          request_role: n === 1 ? 'root' : 'continuation', admission_id: `${rid}:${n}`,
          call_ordinal: n, prior_root_generations: n - 1, initial_request: n === 1,
          route: meta.route, source: 'provider_response_sse', request_body_sha256: sha(Buffer.from(raw)),
          task_prompt_sha256: meta.task_prompt_sha256, response_bytes_sha256: hash.digest('hex'),
          response_byte_count: count, http_status: status, response_content_type: contentType,
          requested_stream: body.stream === true, transport_outcome: outcome,
          downstream_delivery_failed: deliveryFailed, capture_write_complete: healthy,
          observer_source_sha256: observerHash, installed_adapter_sha256: ADAPTER_PIN,
          binding_source_sha256: BINDING_PIN, binding_contract_sha256: meta.binding.expected.contract_sha256,
          initial_binding_verified: n === 1,
        };
        // Publication is non-replacing. A crash leaves absent/partial evidence,
        // never permission to infer clean EOF from the raw response file alone.
        const receiptBytes = Buffer.from(JSON.stringify(receipt) + '\n');
        publishReceipt(`capture-receipt-${suffix}.json`, receiptBytes);
        // No signal is emitted until receipt file AND publication directory sync
        // have succeeded. Only the trusted parent may mint durable inventory.
        process.send({ kind: 'luna.capture.published.current.v5', schema_version: 1,
          channel_id: meta.publication_channel_id, protocol_id: meta.protocol_id,
          run_id: rid, root_turn_id: meta.root_turn_id, admission_id: `${rid}:${n}`,
          call_ordinal: n, publication_ordinal: n, receipt_sha256: sha(receiptBytes),
          request_body_sha256: receipt.request_body_sha256,
          response_bytes_sha256: receipt.response_bytes_sha256, response_byte_count: count,
          observer_source_sha256: observerHash, installed_adapter_sha256: ADAPTER_PIN,
          binding_source_sha256: BINDING_PIN, binding_contract_sha256: meta.binding.expected.contract_sha256,
        }, () => { /* Send failure means missing parent inventory, not a retry. */ });
      } catch { /* Missing/invalid receipt = unknown; never retry or touch ledger. */ }
    },
  };
}


const root = process.env.LUNA_LEDGER_ROOT;
const dir = process.env.LUNA_RUN_DIR;
const rid = process.env.LUNA_RUN_ID;
const taskCap = Number(process.env.LUNA_TASK_CALL_CAP || 45);
const nativeFetch = globalThis.fetch;
let selectedMetadata = null, transport = null;

// The metadata hash is fixed for this process, not silently adopted from a
// changed environment on later calls. It covers the cap/selection and inventory.
// This is a trusted-runner declaration, not owner approval or wire attestation.
function financialTransport(meta) {
  const metadataHash = meta.metadataSha256;
  if (selectedMetadata !== null) {
    need(metadataHash === selectedMetadata);
    return transport;
  }
  const financial = meta.financial;
  need(financial && typeof financial === 'object' && !Array.isArray(financial));
  need(Object.keys(financial).sort().join() === ['schema_version','spend_policy','policy_id','inventory'].sort().join());
  need(financial.schema_version === 2 && digest(financial.policy_id));
  need(financial.inventory && typeof financial.inventory === 'object' && !Array.isArray(financial.inventory));
  need(Object.keys(financial.inventory).sort().join() ===
    ['rootDev','rootIno','journalDev','journalIno','prefixBytes','prefixSha256'].sort().join());
  const owner = createFinancialOwner({ runId: rid, taskCallCap: taskCap, root,
    inventory: financial.inventory, policyId: financial.policy_id, spendPolicy: financial.spend_policy });
  const next = createFinancialTransport({ owner, nativeFetch });
  selectedMetadata = metadataHash;
  transport = next;
  return transport;
}

globalThis.fetch = async (input, init) => {
  const meta = runnerMetadata();
  let sourceOwner = snapshotRequest(input, init);
  const controller = new AbortController();
  const abort = () => controller.abort();
  function release() {
    if (sourceOwner === undefined) return;
    const retained = sourceOwner; sourceOwner = undefined;
    retained.signal.removeEventListener('abort', abort);
  }
  sourceOwner.signal.addEventListener('abort', abort, { once: true });
  if (sourceOwner.signal.aborted) abort();
  try {
    const snapshot = sourceOwner.snapshot;
    const url = new URL(snapshot.url);
    // No unpriced auxiliary pass-through.
    need(url.href === 'https://api.openai.com/v1/responses' && snapshot.method === 'POST');
    const raw = await boundedRequestBytes(snapshot, controller.signal);
    const body = strictJson(raw);
    const forwarded = new Request(snapshot, { body: Buffer.from(raw),
      referrer: snapshot.referrer, referrerPolicy: snapshot.referrerPolicy,
      redirect: 'manual', signal: controller.signal });
    const selected = financialTransport(meta);
    const result = await selected.send({ request: forwarded, bodyBytes: raw,
      requestSha256: sha(raw), outputCap: body.max_output_tokens,
      beforeAdmit({ ordinal, bodyBytes }) {
        checkFixedPolicy(meta, Buffer.from(bodyBytes), ordinal);
        if (ordinal === 1) bindInitial(Buffer.from(bodyBytes), meta);
      },
      createCapture({ ordinal }) { return capture(meta, ordinal, raw, body); },
    });
    // Both outcomes release original input/snapshot ownership, not on send's
    // early return. Abandoned response bodies remain outstanding by design.
    result.accounting.then(release, release);
    return result.response;
  } catch (cause) {
    release();
    throw cause;
  }
};

