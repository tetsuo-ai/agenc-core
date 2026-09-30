// Offline integration component. Caller owns pre-admission policy/binding and
// immutable deployment pins; this module never constructs or discovers a ledger.
import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { parseLedgerBytes, numericLexeme } from '../luna-finance-v1/ledger-json.mjs';

const LIMIT = 1024 * 1024;
const ENDPOINT = 'https://api.openai.com/v1/responses';
const promiseThen = Promise.prototype.then;
const safeError = () => new Error('Financial transport refused');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const check = value => { if (!value) throw safeError(); };
function consume(promise) {
  // Trusted native Promise only; never assimilate optional arbitrary thenables.
  try { if (types.isPromise(promise)) Reflect.apply(promiseThen, promise, [() => undefined, () => undefined]); }
  catch { /* Optional evidence has no financial authority. */ }
}
function raceAbort(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(safeError()); };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); },
      () => { signal.removeEventListener('abort', abort); reject(safeError()); });
    if (signal.aborted) abort();
  });
}
function cancel(reader) {
  try { consume(reader?.cancel(safeError())); } catch { /* No financial retry. */ }
}
async function boundedBody(request, signal) {
  check(request.body !== null);
  const reader = request.body.getReader(), chunks = [];
  let length = 0, complete = false;
  try {
    for (;;) {
      const value = await raceAbort(reader.read(), signal);
      if (value.done) { complete = true; break; }
      check(value.value instanceof Uint8Array);
      length += value.value.byteLength; check(length <= LIMIT);
      chunks.push(Buffer.from(value.value));
    }
    return Buffer.concat(chunks, length);
  } finally {
    if (!complete) cancel(reader);
    try { reader.releaseLock(); } catch { /* Pending read was cancelled, never sent. */ }
  }
}

/**
 * owner must be the pinned createFinancialOwner result. nativeFetch is trusted
 * to make exactly the requested physical attempt and honor manual redirects.
 * Caller's strict per-call policy/initial binding must precede this invocation.
 */
export function createFinancialTransport({ owner, nativeFetch }) {
  check(owner && typeof owner.admit === 'function' && typeof owner.nextOrdinal === 'function' && typeof nativeFetch === 'function');
  async function send({ request, bodyBytes, requestSha256, outputCap, beforeAdmit, createCapture } = {}) {
    // Snapshot caller-owned objects before awaiting. Private Request metadata and
    // bytes cannot be changed through the original Request/Headers/typed array.
    check(request instanceof Request && !request.bodyUsed && bodyBytes instanceof Uint8Array
      && bodyBytes.byteLength > 0 && bodyBytes.byteLength <= LIMIT
      && typeof requestSha256 === 'string' && /^[a-f0-9]{64}$/.test(requestSha256)
      && Number.isSafeInteger(outputCap) && outputCap > 0 && outputCap <= 8192 && typeof beforeAdmit === 'function');
    // Keep the caller's actual signal, not Request.clone()'s dependent signal:
    // Node 26 can lose clone propagation after garbage collection.
    let sourceOwner = { request, signal: request.signal };
    const sourceSignal = sourceOwner.signal;
    const bytes = Buffer.from(bodyBytes), snapshot = request.clone();
    check(snapshot.url === ENDPOINT && snapshot.method === 'POST' && hash(bytes) === requestSha256);
    check(!sourceSignal.aborted);
    // Current source emits single-line JSON. Reuse exact numeric/duplicate-key
    // parser instead of Number-rounding the declared stream/cap control.
    const parsed = parseLedgerBytes(Buffer.concat([bytes, Buffer.from('\n')]));
    check(parsed.length === 1 && parsed[0].stream === true && parsed[0].model === 'gpt-6-luna'
      && numericLexeme(parsed[0].max_output_tokens) === String(outputCap));
    const original = await boundedBody(snapshot, sourceSignal);
    check(original.equals(bytes) && !sourceSignal.aborted);
    const abortController = new AbortController();
    const outgoing = new Request(snapshot, { body: bytes, redirect: 'manual', signal: abortController.signal,
      referrer: snapshot.referrer, referrerPolicy: snapshot.referrerPolicy });
    // Construct everything that can refuse input before acquiring a reservation.
    const ordinal = owner.nextOrdinal();
    let approval;
    try { approval = beforeAdmit(Object.freeze({ ordinal, bodyBytes: new Uint8Array(bytes), requestSha256, outputCap })); }
    catch { throw safeError(); }
    if (approval !== undefined) { consume(approval); throw safeError(); }
    check(!sourceSignal.aborted && owner.nextOrdinal() === ordinal && hash(bytes) === requestSha256);
    const admitted = owner.admit(bytes, outputCap); // Synchronous durable commit.
    let attempted = false, receipt, accountingError, stopped = false;
    let status = null, contentType = null, reader, downstream, receivedResponse;
    let captureFinished = false, captureFailed = false, capture, captureInitializing = false, deferredCaptureFinish;
    let resolveAccounting, rejectAccounting;
    const accounting = new Promise((resolve, reject) => { resolveAccounting = resolve; rejectAccounting = reject; });
    // Consumed even if downstream ignores it; explicit await still rejects.
    accounting.catch(() => undefined);
    function optional(method, args) {
      try {
        const callback = capture?.[method];
        if (callback === undefined) return;
        check(typeof callback === 'function');
        const result = Reflect.apply(callback, capture, args);
        if (result !== undefined) { captureFailed = true; consume(result); }
      } catch { captureFailed = true; }
    }
    function finishCapture(outcome, deliveryFailed) {
      if (captureFinished) return;
      if (captureInitializing) { deferredCaptureFinish ??= [outcome, deliveryFailed]; return; }
      captureFinished = true;
      optional('finish', [outcome, status, contentType, deliveryFailed, captureFailed]);
    }
    function settle(outcome) {
      if (attempted) return receipt;
      attempted = true;
      try { receipt = admitted.finish(outcome); resolveAccounting(receipt); }
      catch { accountingError = safeError(); rejectAccounting(accountingError); }
      return receipt;
    }
    function endUnknown(outcome) {
      if (stopped) return;
      stopped = true;
      detachAbort();
      settle(outcome);
      abortController.abort();
      if (reader) cancel(reader);
      else cancelReceivedResponse();
      finishCapture(outcome, true);
      try { downstream?.error(safeError()); } catch { /* Already closed/cancelled. */ }
    }
    function detachAbort() {
      // Retain the Request itself until terminal cleanup: on Node 26, keeping
      // only its signal is insufficient once the caller drops the Request.
      const retained = sourceOwner;
      sourceOwner = undefined;
      retained.signal.removeEventListener('abort', abort);
    }
    function cancelReceivedResponse() {
      // Own the resolved response even before the awaiting continuation gets a
      // reader. Clear first so a resolution/abort race cannot cancel twice.
      const received = receivedResponse; receivedResponse = undefined;
      try { consume(received?.body?.cancel(safeError())); } catch { /* Never retry. */ }
    }
    function abort() { endUnknown('aborted'); }
    sourceSignal.addEventListener('abort', abort, { once: true });
    if (sourceSignal.aborted) abort();
    try {
      check(!stopped && admitted.ordinal === ordinal && admitted.requestSha256 === requestSha256);
      if (createCapture !== undefined) {
        captureInitializing = true;
        try {
          check(typeof createCapture === 'function');
          const candidate = createCapture(Object.freeze({ ordinal, requestSha256, bodyBytes: new Uint8Array(bytes) }));
          if (types.isPromise(candidate)) { consume(candidate); captureFailed = true; }
          else if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) captureFailed = true;
          else capture = candidate;
        } catch { captureFailed = true; }
        finally {
          captureInitializing = false;
          if (deferredCaptureFinish) finishCapture(...deferredCaptureFinish);
        }
      }
      check(!stopped);
      const pending = Promise.resolve(nativeFetch(outgoing));
      pending.then(response => {
        receivedResponse = response;
        if (stopped) cancelReceivedResponse();
      }, () => undefined);
      const response = await raceAbort(pending, abortController.signal);
      check(!stopped && response instanceof Response);
      status = response.status; contentType = response.headers.get('content-type');
      if (response.body !== null) reader = response.body.getReader();
      receivedResponse = undefined; // Ownership transferred synchronously to reader.
      try { admitted.headers(status, contentType); } catch { endUnknown('evidence_error'); throw safeError(); }
      if (response.redirected || (response.url !== '' && response.url !== ENDPOINT)
        || status >= 300 && status < 400) {
        endUnknown('redirect'); throw safeError();
      }
      if (status !== 200) { endUnknown('http_error'); throw safeError(); }
      if (!reader) { endUnknown('missing_body'); throw safeError(); }
      const stream = new ReadableStream({
        start(controller) { downstream = controller; },
        async pull(controller) {
          if (stopped) return;
          try {
            const part = await raceAbort(reader.read(), abortController.signal);
            if (stopped) return;
            if (part.done) {
              // Only the physical reader's done flag can select eof accounting.
              stopped = true; detachAbort();
              const result = settle('eof');
              try { reader.releaseLock(); } catch { /* Read reached physical EOF. */ }
              if (accountingError || result?.state !== 'known_charge_committed') {
                finishCapture('eof', true); controller.error(safeError()); return;
              }
              try { controller.close(); finishCapture('eof', false); }
              catch { finishCapture('delivery_error', true); }
              return;
            }
            check(part.value instanceof Uint8Array);
            const chunk = new Uint8Array(part.value);
            try { admitted.push(chunk); } catch { endUnknown('evidence_error'); return; }
            optional('add', [new Uint8Array(chunk)]); // Never expose forwarded bytes.
            if (stopped) return;
            try { controller.enqueue(chunk); }
            catch { endUnknown('delivery_error'); }
          } catch { if (!stopped) endUnknown('read_error'); }
        },
        cancel() { endUnknown('cancelled'); },
      }, { highWaterMark: 0 });
      const forwarded = new Response(stream, { status, statusText: response.statusText, headers: response.headers });
      return Object.freeze({ response: forwarded, accounting });
    } catch {
      if (!stopped) endUnknown('fetch_error');
      throw safeError();
    }
  }
  return Object.freeze({ async send(input) {
    try { return await send(input); } catch { throw safeError(); }
  } });
}
