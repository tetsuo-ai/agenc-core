from pathlib import Path
r=Path('/private/tmp/light-ultra/core-speed/runtime')
p=r/'src/thread-store/store.ts';s=p.read_text();s=s.replace('''export interface CreateThreadParams {
''','''export interface CreateThreadParams {
  /** Light only: coalesce the derived search/list index, never canonical writes. */
  readonly coalesceDerivedIndex?: boolean;
''').replace('''export interface ResumeThreadParams {
''','''export interface ResumeThreadParams {
  readonly coalesceDerivedIndex?: boolean;
''')
s=s.replace('''  private readonly liveRecorders = new Map<ThreadId, RolloutStore>();''','''  private readonly liveRecorders = new Map<ThreadId, RolloutStore>();
  private readonly pendingIndexes = new Map<string, ReturnType<typeof setTimeout>>();''')
s=s.replace('''this.bindLiveRecorder(threadId, params.rolloutStore);''','''this.bindLiveRecorder(threadId, params.rolloutStore, params.coalesceDerivedIndex === true);''')
s=s.replace('''  persistThread(threadId: ThreadId): void {
    this.assertOpen();
    const recorder = this.liveRecorderOrThrow(threadId);
    recorder.flushDurable();
''','''  persistThread(threadId: ThreadId): void {
    this.assertOpen();
    const recorder = this.liveRecorderOrThrow(threadId);
    recorder.flushDurable();
    this.indexRolloutFile(recorder.rolloutPath);
''')
s=s.replace('''  flushThread(threadId: ThreadId): void {
    this.assertOpen();
    const recorder = this.liveRecorderOrThrow(threadId);
    recorder.flushDurable();
''','''  flushThread(threadId: ThreadId): void {
    this.assertOpen();
    const recorder = this.liveRecorderOrThrow(threadId);
    recorder.flushDurable();
    this.indexRolloutFile(recorder.rolloutPath);
''')
s=s.replace('''  listThreads(params: ListThreadsParams): ThreadPage {
    this.assertOpen();''','''  listThreads(params: ListThreadsParams): ThreadPage {
    this.assertOpen();
    this.flushPendingIndexes();''')
s=s.replace('''  close(): void {
    if (this.closed) return;
    this.closed = true;''','''  close(): void {
    if (this.closed) return;
    this.flushPendingIndexes();
    this.closed = true;''')
s=s.replace('''  private indexRolloutFile(rolloutPath: string): void {
    backfillRolloutFile({''','''  private indexRolloutFile(rolloutPath: string): void {
    const pending = this.pendingIndexes.get(rolloutPath);
    if (pending !== undefined) {
      clearTimeout(pending);
      this.pendingIndexes.delete(rolloutPath);
    }
    backfillRolloutFile({''')
s=s.replace('''  private bindLiveRecorder(threadId: ThreadId, rolloutStore: RolloutStore): void {''','''  private flushPendingIndexes(): void {
    for (const path of [...this.pendingIndexes.keys()]) this.indexRolloutFile(path);
  }

  private bindLiveRecorder(threadId: ThreadId, rolloutStore: RolloutStore, coalesce = false): void {''')
s=s.replace('''      if (this.liveRecorders.get(threadId) !== rolloutStore) return;
      this.indexRolloutFile(rolloutPath);''','''      if (this.liveRecorders.get(threadId) !== rolloutStore) return;
      if (!coalesce) {
        this.indexRolloutFile(rolloutPath);
        return;
      }
      if (this.pendingIndexes.has(rolloutPath)) return;
      const timer = setTimeout(() => {
        this.pendingIndexes.delete(rolloutPath);
        if (this.closed || this.liveRecorders.get(threadId) !== rolloutStore) return;
        try {
          this.indexRolloutFile(rolloutPath);
        } catch {
          // This is a rebuildable search/list projection. Canonical appends,
          // admission decisions and effect receipts were already committed.
          // Explicit reads/flushes repair it synchronously and surface errors.
          console.warn("agenc: deferred Light thread index refresh failed");
        }
      }, 500);
      timer.unref?.();
      this.pendingIndexes.set(rolloutPath, timer);''')
s=s.replace('''    if (this.liveRecorders.get(threadId) === rolloutStore) {
      this.liveRecorders.delete(threadId);''','''    if (this.liveRecorders.get(threadId) === rolloutStore) {
      if (this.pendingIndexes.has(rolloutStore.rolloutPath)) this.indexRolloutFile(rolloutStore.rolloutPath);
      this.liveRecorders.delete(threadId);''');p.write_text(s)
p=r/'src/thread-store/live-thread.ts';s=p.read_text().replace('''export interface CreateLiveThreadParams {
''','''export interface CreateLiveThreadParams {
  readonly coalesceDerivedIndex?: boolean;
''').replace('''export interface ResumeLiveThreadParams {
''','''export interface ResumeLiveThreadParams {
  readonly coalesceDerivedIndex?: boolean;
''')
s=s.replace('''      threadId: params.threadId,
      rolloutStore: params.rolloutStore,''','''      threadId: params.threadId,
      rolloutStore: params.rolloutStore,
      ...(params.coalesceDerivedIndex === true ? { coalesceDerivedIndex: true } : {}),''');p.write_text(s)
p=r/'src/bin/bootstrap-services.ts';s=p.read_text().replace('''            threadId: binding.session.conversationId,
            rolloutStore: binding.rolloutStore,''','''            threadId: binding.session.conversationId,
            ...(opts.runtimeOptions.lightMode === true ? { coalesceDerivedIndex: true } : {}),
            rolloutStore: binding.rolloutStore,''');p.write_text(s)
p=r/'tests/session/thread-store.test.ts';s=p.read_text();s+='''

describe("Light derived-index coalescing", () => {
  it("keeps canonical writes durable and publishes one projection at an explicit barrier", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-light-index-"));
    const rollout = openStore({ cwd, sessionId: "light-index" });
    const store = new FileThreadStore({ agencHome, cwd });
    const commits = vi.spyOn(StateThreadRepository.prototype, "commitRolloutProjection");
    try {
      store.createThread({ threadId: "light-index", rolloutStore: rollout, coalesceDerivedIndex: true });
      commits.mockClear();
      for (let index = 0; index < 3; index++) rollout.appendRollout(responseItem(`message-${index}`, `committed-${index}`), { durable: true });
      expect(readFileSync(rollout.rolloutPath, "utf8")).toContain("committed-2");
      expect(commits).not.toHaveBeenCalled();
      store.flushThread("light-index");
      expect(commits).toHaveBeenCalledTimes(1);
      expect(store.loadHistory({ threadId: "light-index", includeArchived: false }).items.length).toBeGreaterThan(3);
    } finally {
      commits.mockRestore(); store.close(); rollout.close(); rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("drains a pending projection on shutdown without delaying canonical durability", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-light-index-close-"));
    const rollout = openStore({ cwd, sessionId: "light-index-close" });
    const store = new FileThreadStore({ agencHome, cwd });
    const commits = vi.spyOn(StateThreadRepository.prototype, "commitRolloutProjection");
    try {
      store.createThread({ threadId: "light-index-close", rolloutStore: rollout, coalesceDerivedIndex: true });
      commits.mockClear();
      rollout.appendRollout(responseItem("committed", "durable"), { durable: true });
      expect(commits).not.toHaveBeenCalled();
      store.shutdownThread("light-index-close");
      expect(commits).toHaveBeenCalledTimes(1);
      expect(readFileSync(rollout.rolloutPath, "utf8")).toContain("durable");
    } finally {
      commits.mockRestore(); store.close(); rollout.close(); rmSync(cwd, { recursive: true, force: true });
    }
  });
});
''';p.write_text(s)
