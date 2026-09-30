from pathlib import Path
root=Path('runtime/src')
def edit(p,f):
 p=root/p;p.write_text(f(p.read_text()))
edit(Path('llm/model-metadata.ts'),lambda s:s.replace('this.fetchJson(OPENROUTER_MODELS_URL)','this.fetchPublicCatalog(OPENROUTER_MODELS_URL)'))
edit(Path('session/session-store.ts'),lambda s:s.replace('  append(event: Event, opts: AppendOptions = {}): boolean {','''  private collectingDurableBatch = false;

  /** One synchronous boundary: no caller can observe a partial acknowledgement. */
  appendDurableBatch(events: readonly Event[]): void {
    if (!this.opened || this.closed || this.collectingDurableBatch) {
      throw new Error("cannot begin durable rollout batch");
    }
    this.collectingDurableBatch = true;
    try {
      for (const event of events) {
        if (!this.append(event, { durable: true })) {
          throw new Error("durable rollout batch append failed");
        }
      }
    } finally {
      this.collectingDurableBatch = false;
    }
    if (!this.flushBatch(true)) throw new Error("durable rollout batch was not fsync-committed");
  }

  append(event: Event, opts: AppendOptions = {}): boolean {''').replace('    if (durable) {\n      return this.flushBatch(/*durable*/ true);','    if (this.collectingDurableBatch) return true;\n    if (durable) {\n      return this.flushBatch(/*durable*/ true);'))
edit(Path('session/rollout-store.ts'),lambda s:s.replace('  append(event: Event, opts: AppendOptions = {}): boolean {','''  appendDurableBatch(events: readonly Event[]): void {
    this.store.appendDurableBatch(events);
  }

  append(event: Event, opts: AppendOptions = {}): boolean {'''))
edit(Path('session/session.ts'),lambda s:s.replace('  emit(event: Event, appendOpts: AppendOptions = {}): Event {','''  /** Admission rows and their derived usage become visible after one durable flush. */
  emitAdmissionBatch(events: readonly Event[]): readonly Event[] {
    if (this.canonicalJournalSealed || this.isRolloutPersistenceSuspended() || !this.rolloutStore) {
      throw new Error("admission batch requires an active canonical journal");
    }
    if (events.some(event => event.msg.type !== "execution_admission" && event.msg.type !== "session_usage")) {
      throw new Error("unsupported admission batch event");
    }
    const stamped = events.map(event => this.eventLog.stamp(event));
    this.rolloutStore.appendDurableBatch(stamped);
    for (const event of stamped) this.publishPreparedEvent(event);
    return stamped;
  }

  emit(event: Event, appendOpts: AppendOptions = {}): Event {'''))
edit(Path('budget/admission-client.ts'),lambda s:s.replace('  subscribeCritical?(\n','''  /** A committed boundary, projected and acknowledged as one durable group. */
  subscribeCriticalBatch?(listener: (events: readonly AdmissionJournalEvent[]) => void): () => void;
  subscribeCritical?(
'''))
def kernel(s):
 needle='  readonly #criticalListeners = new Map<'
 s=s.replace(needle,'''  readonly #criticalBatchListeners = new Map<string, Set<(events: readonly AdmissionJournalEvent[]) => void>>();
'''+needle)
 needle='  subscribeCritical(\n    runId: string,'
 s=s.replace(needle,'''  subscribeCriticalBatch(runId: string, listener: (events: readonly AdmissionJournalEvent[]) => void): () => void {
    const listeners = this.#criticalBatchListeners.get(runId) ?? new Set();
    listeners.add(listener);
    this.#criticalBatchListeners.set(runId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#criticalBatchListeners.delete(runId);
    };
  }

'''+needle)
 s=s.replace('    this.#criticalListeners.clear();','    this.#criticalListeners.clear();\n    this.#criticalBatchListeners.clear();')
 s=s.replace('        this.#criticalListeners.delete(runId);','        this.#criticalListeners.delete(runId);\n        this.#criticalBatchListeners.delete(runId);')
 needle='      if (events.length === 0) return;\n      for (const event of events) {'
 assert needle in s
 s=s.replace(needle,'''      if (events.length === 0) return;
      // All SQLite writes committed before any canonical projection or observer.
      // Do not advance the cursor if any group fails; retry is identity-idempotent.
      hitM4DurabilityFailpoint("after_admission_sqlite_commit_before_canonical_append");
      const groups = new Map<string, AdmissionJournalEvent[]>();
      for (const event of events) {
        const group = groups.get(event.runId) ?? [];
        group.push(event);
        groups.set(event.runId, group);
      }
      for (const [runId, group] of groups) {
        for (const listener of this.#criticalBatchListeners.get(runId) ?? []) listener(group);
      }
      for (const event of events) {''')
 needle='  subscribeCritical(\n    listener: (event: AdmissionJournalEvent) => void,'
 s=s.replace(needle,'''  subscribeCriticalBatch(listener: (events: readonly AdmissionJournalEvent[]) => void): () => void {
    return this.kernel.subscribeCriticalBatch(this.scope.runId, listener);
  }

'''+needle)
 return s
edit(Path('budget/execution-admission-kernel.ts'),kernel)
def journal(s):
 needle='  const unsubscribe =\n    admission.subscribeCritical?.(append) ?? admission.subscribe(append);'
 assert needle in s
 s=s.replace(needle,'''  let lastUsageSequence = -1;
  let lastUsageSignature = "";
  const appendBatch = (payloads: readonly AdmissionJournalEvent[]): void => {
    const rollout = session.rolloutStore;
    if (!rollout || typeof session.emitAdmissionBatch !== "function") {
      for (const payload of payloads) append(payload);
      return;
    }
    const fresh: Event[] = [];
    for (const payload of payloads) {
      const existing = findExecutionAdmissionEvent(rollout, payload.eventId);
      if (existing) assertMatchingExecutionAdmissionEvent(existing, payload);
      else fresh.push({ eventId: payload.eventId, id: payload.eventId, msg: { type: "execution_admission", payload } });
    }
    const usage = admission.getUsageSummary?.();
    const signature = usage === undefined ? "" : JSON.stringify({ ...usage, sequence: 0 });
    if (usage && signature !== lastUsageSignature) {
      fresh.push({ id: `usage:${usage.runId}:${usage.sequence}`, eventId: randomUUID(), msg: { type: "session_usage", payload: usage } });
    }
    try {
      if (fresh.length > 0) {
        for (const event of session.emitAdmissionBatch(fresh)) {
          if (event.msg.type === "execution_admission") rememberExecutionAdmissionEvent(rollout, event);
        }
      } else rollout.syncCanonicalTail();
      if (usage) { lastUsageSequence = usage.sequence; lastUsageSignature = signature; }
    } catch (error) {
      // A post-fsync publication error may leave a committed prefix. Rebuild
      // from the canonical bytes on retry, never from an uncommitted cache.
      executionAdmissionEventIndexes.delete(rollout);
      throw error;
    }
  };
  const unsubscribe = admission.subscribeCriticalBatch?.(appendBatch) ??
    admission.subscribeCritical?.(append) ?? admission.subscribe(append);''')
 s=s.replace('    let lastUsageSequence = -1;\n','')
 s=s.replace('      lastUsageSequence = summary.sequence;','      lastUsageSequence = summary.sequence;\n      lastUsageSignature = JSON.stringify({ ...summary, sequence: 0 });')
 return s
edit(Path('session/execution-admission-journal.ts'),journal)
