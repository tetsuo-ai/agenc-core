import { existsSync, readdirSync, realpathSync, statSync, watch as nodeWatch, type FSWatcher } from "node:fs";
import path from "node:path";

import { AsyncLock } from "../utils/async-lock.js";

/**
 * Ports upstream Rust `core/src/file_watcher.rs` onto AgenC's Node runtime.
 *
 * Why this lives here / shape difference from upstream:
 *   - Node's single event loop owns state transitions, while the receiver uses
 *     AgenC's AsyncLock to preserve the upstream coalescing invariant.
 *
 * Cross-cuts deliberately NOT carried:
 *   - Rust tracing warnings; live watcher setup failures are represented by
 *     omitted backend watches so subscribers keep synthetic/test semantics.
 */

export interface FileWatcherEvent {
  /** Changed paths delivered in sorted order with duplicates removed. */
  readonly paths: string[];
}

export interface WatchPath {
  /** Root path to watch. */
  readonly path: string;
  /** Whether events below `path` should match recursively. */
  readonly recursive: boolean;
}

export type WatchMode = "non-recursive" | "recursive";

export interface WatchCounts {
  readonly nonRecursive: number;
  readonly recursive: number;
}

export type FileWatcherRawEventKind =
  | "access"
  | "change"
  | "create"
  | "modify"
  | "remove"
  | "rename"
  | "other";

export interface FileWatcherRawEvent {
  readonly kind: FileWatcherRawEventKind;
  readonly paths: readonly string[];
}

export type FileWatcherWatchFactory = (
  pathToWatch: string,
  options: { readonly recursive?: boolean },
  listener: (eventType: string, filename: Buffer | string | null) => void,
) => FSWatcher;

export interface FileWatcherCreateOptions {
  readonly watch?: FileWatcherWatchFactory;
}

type SubscriberId = number;

interface ReceiverState {
  changedPaths: Set<string>;
  waiters: Array<() => void>;
  senderCount: number;
}

class ReceiverInner {
  readonly lock = new AsyncLock<ReceiverState>({
    changedPaths: new Set<string>(),
    waiters: [],
    senderCount: 1,
  });
}

class WatchSender {
  #closed = false;

  constructor(private readonly inner: ReceiverInner) {}

  clone(): WatchSender | null {
    const state = this.inner.lock.unsafePeek();
    if (this.#closed || state.senderCount === 0) return null;
    state.senderCount += 1;
    return new WatchSender(this.inner);
  }

  async addChangedPaths(pathsToAdd: readonly string[]): Promise<void> {
    if (pathsToAdd.length === 0) return;

    await this.inner.lock.with((state) => {
      const previousSize = state.changedPaths.size;
      for (const changedPath of pathsToAdd) {
        state.changedPaths.add(changedPath);
      }
      if (state.changedPaths.size !== previousSize) {
        state.waiters.shift()?.();
      }
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;

    void this.inner.lock.with((state) => {
      state.senderCount = Math.max(0, state.senderCount - 1);
      if (state.senderCount === 0) {
        const waiters = state.waiters.splice(0);
        for (const waiter of waiters) waiter();
      }
    });
  }
}

function watchChannel(): { readonly sender: WatchSender; readonly receiver: FileWatcherReceiver } {
  const inner = new ReceiverInner();
  return {
    sender: new WatchSender(inner),
    receiver: new FileWatcherReceiver(inner),
  };
}

type ReceiverDecision =
  | { readonly kind: "closed" }
  | { readonly kind: "event"; readonly event: FileWatcherEvent }
  | { readonly kind: "wait"; readonly promise: Promise<void> };

/** Receives coalesced change notifications for a single subscriber. */
export class FileWatcherReceiver {
  constructor(private readonly inner: ReceiverInner) {}

  /**
   * Wait for the next batch, or return null after the subscriber is removed
   * and all pending paths have been flushed.
   */
  async recv(): Promise<FileWatcherEvent | null> {
    while (true) {
      const decision = await this.inner.lock.with<ReceiverDecision>((state) => {
        if (state.changedPaths.size > 0) {
          const paths = [...state.changedPaths].sort();
          state.changedPaths.clear();
          return { kind: "event", event: { paths } };
        }
        if (state.senderCount === 0) return { kind: "closed" };
        return {
          kind: "wait",
          promise: new Promise<void>((resolve) => {
            state.waiters.push(resolve);
          }),
        };
      });

      if (decision.kind === "closed") return null;
      if (decision.kind === "event") return decision.event;
      await decision.promise;
    }
  }
}

/** Coalesces bursts of watch notifications and emits at most once per interval. */
export class ThrottledWatchReceiver {
  #nextAllowedAtMs: number | null = null;

  constructor(
    private readonly receiver: FileWatcherReceiver,
    private readonly intervalMs: number,
  ) {}

  async recv(): Promise<FileWatcherEvent | null> {
    if (this.#nextAllowedAtMs !== null) {
      const remaining = this.#nextAllowedAtMs - Date.now();
      if (remaining > 0) await sleep(remaining);
    }

    const event = await this.receiver.recv();
    if (event !== null) {
      this.#nextAllowedAtMs = Date.now() + this.intervalMs;
    }
    return event;
  }
}

class PathWatchCounts {
  nonRecursive = 0;
  recursive = 0;

  increment(recursive: boolean, amount: number): void {
    if (recursive) this.recursive += amount;
    else this.nonRecursive += amount;
  }

  decrement(recursive: boolean, amount: number): void {
    if (recursive) this.recursive = Math.max(0, this.recursive - amount);
    else this.nonRecursive = Math.max(0, this.nonRecursive - amount);
  }

  effectiveMode(): WatchMode | null {
    if (this.recursive > 0) return "recursive";
    if (this.nonRecursive > 0) return "non-recursive";
    return null;
  }

  isEmpty(): boolean {
    return this.nonRecursive === 0 && this.recursive === 0;
  }
}

interface WatchState {
  nextSubscriberId: SubscriberId;
  pathRefCounts: Map<string, PathWatchCounts>;
  subscribers: Map<SubscriberId, SubscriberState>;
}

interface SubscriberState {
  watchedPaths: Map<string, SubscriberWatchState>;
  tx: WatchSender;
}

interface SubscriberWatchKey {
  readonly requested: WatchPath;
  readonly matched: WatchPath;
}

interface SubscriberWatchState {
  readonly key: SubscriberWatchKey;
  actual: WatchPath;
  count: number;
  lastExists: boolean;
  fallback: boolean;
}

interface SubscriberWatchRegistration {
  readonly key: SubscriberWatchKey;
  readonly actual: WatchPath;
  readonly fallback: boolean;
}

interface ActualWatchPathResult {
  readonly actual: WatchPath;
  readonly matched: WatchPath;
  readonly fallback: boolean;
}

interface FileWatcherInner {
  watchedPaths: Map<string, WatchMode>;
  watchers: Map<string, WatchBackend>;
}

interface WatchBackend {
  readonly recursiveFallback: boolean;
  readonly watchers: readonly FSWatcher[];
}

const defaultWatchFactory: FileWatcherWatchFactory = (pathToWatch, options, listener) =>
  nodeWatch(pathToWatch, options, listener);

/** Handle used to register watched paths for one logical consumer. */
export class FileWatcherSubscriber {
  #closed = false;

  constructor(
    private readonly id: SubscriberId,
    private readonly fileWatcher: FileWatcher,
  ) {}

  registerPaths(watchedPaths: readonly WatchPath[]): WatchRegistration {
    if (this.#closed) return new WatchRegistration(null, this.id, []);

    const registrations = dedupeWatchedPaths(watchedPaths).map((requested) => {
      const { actual, matched, fallback } = actualWatchPath(requested);
      return {
        key: { requested, matched },
        actual,
        fallback,
      };
    });
    this.fileWatcher.registerPaths(this.id, registrations);

    return new WatchRegistration(
      this.fileWatcher,
      this.id,
      registrations.map((registration) => registration.key),
    );
  }

  registerPath(pathToWatch: string, recursive: boolean): WatchRegistration {
    return this.registerPaths([{ path: pathToWatch, recursive }]);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.fileWatcher.removeSubscriber(this.id);
  }
}

/** Guard for a set of active path registrations. */
export class WatchRegistration {
  #closed = false;

  constructor(
    private readonly fileWatcher: FileWatcher | null,
    private readonly subscriberId: SubscriberId,
    private readonly watchedPaths: readonly SubscriberWatchKey[],
  ) {}

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.fileWatcher?.unregisterPaths(this.subscriberId, this.watchedPaths);
  }
}

/** Multi-subscriber file watcher built on top of Node filesystem events. */
export class FileWatcher {
  readonly #inner: FileWatcherInner | null;
  readonly #watchFactory: FileWatcherWatchFactory;
  readonly #state: WatchState = {
    nextSubscriberId: 0,
    pathRefCounts: new Map<string, PathWatchCounts>(),
    subscribers: new Map<SubscriberId, SubscriberState>(),
  };
  #closed = false;

  private constructor(inner: FileWatcherInner | null, watchFactory: FileWatcherWatchFactory) {
    this.#inner = inner;
    this.#watchFactory = watchFactory;
  }

  static create(options: FileWatcherCreateOptions = {}): FileWatcher {
    return new FileWatcher({
      watchedPaths: new Map<string, WatchMode>(),
      watchers: new Map<string, WatchBackend>(),
    }, options.watch ?? defaultWatchFactory);
  }

  /** Creates an inert watcher that only supports synthetic notifications. */
  static noop(): FileWatcher {
    return new FileWatcher(null, defaultWatchFactory);
  }

  addSubscriber(): { readonly subscriber: FileWatcherSubscriber; readonly receiver: FileWatcherReceiver } {
    if (this.#closed) {
      const { sender, receiver } = watchChannel();
      sender.close();
      return { subscriber: new FileWatcherSubscriber(-1, this), receiver };
    }

    const { sender, receiver } = watchChannel();
    const subscriberId = this.#state.nextSubscriberId;
    this.#state.nextSubscriberId += 1;
    this.#state.subscribers.set(subscriberId, {
      watchedPaths: new Map<string, SubscriberWatchState>(),
      tx: sender,
    });

    return {
      subscriber: new FileWatcherSubscriber(subscriberId, this),
      receiver,
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;

    for (const subscriber of this.#state.subscribers.values()) {
      subscriber.tx.close();
    }
    this.#state.subscribers.clear();
    this.#state.pathRefCounts.clear();

    if (this.#inner !== null) {
      for (const backend of this.#inner.watchers.values()) {
        for (const watcher of backend.watchers) {
          watcher.close();
        }
      }
      this.#inner.watchers.clear();
      this.#inner.watchedPaths.clear();
    }
  }

  liveWatcherCountForTest(pathToWatch: string): number {
    return this.#inner?.watchers.get(pathToWatch)?.watchers.length ?? 0;
  }

  async sendPathsForTest(paths: readonly string[]): Promise<void> {
    await this.notifySubscribers(paths);
  }

  async notifyRawEventForTest(event: FileWatcherRawEvent): Promise<void> {
    if (!isMutatingEvent(event) || event.paths.length === 0) return;
    await this.notifySubscribers(event.paths);
  }

  watchCountsForTest(pathToWatch: string): WatchCounts | null {
    const counts = this.#state.pathRefCounts.get(pathToWatch);
    if (counts === undefined) return null;
    return { nonRecursive: counts.nonRecursive, recursive: counts.recursive };
  }

  watchedModeForTest(pathToWatch: string): WatchMode | null {
    return this.#inner?.watchedPaths.get(pathToWatch) ?? null;
  }

  registerPaths(subscriberId: SubscriberId, watchedPaths: readonly SubscriberWatchRegistration[]): void {
    if (this.#closed) return;

    for (const registration of watchedPaths) {
      const subscriber = this.#state.subscribers.get(subscriberId);
      if (subscriber === undefined) return;

      const keyId = subscriberWatchKeyId(registration.key);
      const existing = subscriber.watchedPaths.get(keyId);
      const actual = existing?.actual ?? registration.actual;

      if (existing !== undefined) {
        existing.count += 1;
      } else {
        subscriber.watchedPaths.set(keyId, {
          key: registration.key,
          actual: registration.actual,
          count: 1,
          lastExists: pathExists(registration.key.matched.path),
          fallback: registration.fallback,
        });
      }

      const counts = getOrInsertCounts(this.#state.pathRefCounts, actual.path);
      const previousMode = counts.effectiveMode();
      counts.increment(actual.recursive, 1);
      const nextMode = counts.effectiveMode();
      if (previousMode !== nextMode) this.reconfigureWatch(actual.path, nextMode);
    }
  }

  unregisterPaths(subscriberId: SubscriberId, watchedPaths: readonly SubscriberWatchKey[]): void {
    if (this.#closed) return;

    for (const subscriberWatch of watchedPaths) {
      const subscriber = this.#state.subscribers.get(subscriberId);
      if (subscriber === undefined) return;

      const keyId = subscriberWatchKeyId(subscriberWatch);
      const subscriberWatchState = subscriber.watchedPaths.get(keyId);
      if (subscriberWatchState === undefined) continue;

      const actual = subscriberWatchState.actual;
      subscriberWatchState.count = Math.max(0, subscriberWatchState.count - 1);
      if (subscriberWatchState.count === 0) {
        subscriber.watchedPaths.delete(keyId);
      }

      this.decrementPathRef(actual, 1);
    }
  }

  removeSubscriber(subscriberId: SubscriberId): void {
    const subscriber = this.#state.subscribers.get(subscriberId);
    if (subscriber === undefined) return;
    this.#state.subscribers.delete(subscriberId);

    for (const subscriberWatchState of subscriber.watchedPaths.values()) {
      this.decrementPathRef(subscriberWatchState.actual, subscriberWatchState.count);
    }
    subscriber.tx.close();
  }

  private closeBackend(pathToWatch: string): void {
    const backend = this.#inner?.watchers.get(pathToWatch);
    if (backend === undefined) return;
    for (const watcher of backend.watchers) {
      watcher.close();
    }
    this.#inner?.watchers.delete(pathToWatch);
    this.#inner?.watchedPaths.delete(pathToWatch);
  }

  private replaceBackend(pathToWatch: string, mode: WatchMode, backend: WatchBackend): void {
    this.closeBackend(pathToWatch);
    this.#inner?.watchers.set(pathToWatch, backend);
    this.#inner?.watchedPaths.set(pathToWatch, mode);
  }

  private refreshRecursiveFallback(pathToWatch: string): void {
    if (this.#inner === null) return;
    const existing = this.#inner.watchers.get(pathToWatch);
    if (existing === undefined || !existing.recursiveFallback) return;

    const refreshed = this.createRecursiveFallbackBackend(pathToWatch);
    if (refreshed !== null) {
      this.replaceBackend(pathToWatch, "recursive", refreshed);
    }
  }

  private createSingleFsWatcher(
    pathToWatch: string,
    recursive: boolean,
    eventRoot: string,
    recursiveFallback: boolean,
  ): FSWatcher | null {
    try {
      const watcher = this.#watchFactory(pathToWatch, { recursive }, (_eventType, filename) => {
        const eventPath = filename === null ? pathToWatch : path.join(pathToWatch, filename.toString());
        if (recursiveFallback) this.refreshRecursiveFallback(eventRoot);
        void this.notifySubscribers([eventPath]);
      });
      watcher.on("error", () => {
        // Keep backend watcher errors contained; a later reconfiguration or
        // synthetic notification can continue without crashing the daemon.
      });
      watcher.unref();
      return watcher;
    } catch {
      return null;
    }
  }

  private createRecursiveFallbackBackend(pathToWatch: string): WatchBackend | null {
    const directories = recursiveDirectories(pathToWatch);
    if (directories.length === 0) {
      const watcher = this.createSingleFsWatcher(pathToWatch, false, pathToWatch, false);
      return watcher === null ? null : { recursiveFallback: false, watchers: [watcher] };
    }

    const watchers: FSWatcher[] = [];
    for (const dir of directories) {
      const watcher = this.createSingleFsWatcher(dir, false, pathToWatch, true);
      if (watcher !== null) watchers.push(watcher);
    }

    return watchers.length === 0 ? null : { recursiveFallback: true, watchers };
  }

  private createFsWatcher(pathToWatch: string, mode: WatchMode): WatchBackend | null {
    if (mode === "recursive") {
      const nativeRecursive = this.createSingleFsWatcher(pathToWatch, true, pathToWatch, false);
      if (nativeRecursive !== null) {
        return { recursiveFallback: false, watchers: [nativeRecursive] };
      }
      return this.createRecursiveFallbackBackend(pathToWatch);
    }

    const watcher = this.createSingleFsWatcher(pathToWatch, false, pathToWatch, false);
    return watcher === null ? null : { recursiveFallback: false, watchers: [watcher] };
  }

  private decrementPathRef(actual: WatchPath, amount: number): void {
    const counts = this.#state.pathRefCounts.get(actual.path);
    if (counts === undefined) return;

    const previousMode = counts.effectiveMode();
    counts.decrement(actual.recursive, amount);
    const nextMode = counts.effectiveMode();
    if (counts.isEmpty()) this.#state.pathRefCounts.delete(actual.path);
    if (previousMode !== nextMode) this.reconfigureWatch(actual.path, nextMode);
  }

  private applyActualWatchMove(oldActual: WatchPath, newActual: WatchPath, count: number): void {
    if (watchPathEquals(oldActual, newActual)) return;

    this.decrementPathRef(oldActual, count);

    const counts = getOrInsertCounts(this.#state.pathRefCounts, newActual.path);
    const previousMode = counts.effectiveMode();
    counts.increment(newActual.recursive, count);
    const nextMode = counts.effectiveMode();
    if (previousMode !== nextMode) this.reconfigureWatch(newActual.path, nextMode);
  }

  private reconfigureWatch(pathToWatch: string, nextMode: WatchMode | null): void {
    if (this.#inner === null) return;

    const existingMode = this.#inner.watchedPaths.get(pathToWatch) ?? null;
    if (existingMode === nextMode) return;

    if (existingMode !== null) this.closeBackend(pathToWatch);

    if (nextMode === null || !pathExists(pathToWatch)) return;

    const backend = this.createFsWatcher(pathToWatch, nextMode);
    if (backend === null) return;

    this.#inner.watchers.set(pathToWatch, backend);
    this.#inner.watchedPaths.set(pathToWatch, nextMode);
  }

  private async notifySubscribers(eventPaths: readonly string[]): Promise<void> {
    if (this.#closed || eventPaths.length === 0) return;

    const subscribersToNotify: Array<{ readonly tx: WatchSender; readonly changedPaths: string[] }> = [];
    const actualWatchMoves: Array<{
      readonly oldActual: WatchPath;
      readonly newActual: WatchPath;
      readonly count: number;
    }> = [];

    for (const subscriber of this.#state.subscribers.values()) {
      const changedPaths: string[] = [];

      for (const eventPath of eventPaths) {
        for (const subscriberWatchState of subscriber.watchedPaths.values()) {
          const changedPath = changedPathForEvent(subscriberWatchState.key, subscriberWatchState, eventPath);
          if (changedPath !== null) changedPaths.push(changedPath);

          const { actual: newActual, fallback } = actualWatchPath(subscriberWatchState.key.requested);
          subscriberWatchState.fallback = subscriberWatchState.fallback || fallback;
          if (!watchPathEquals(subscriberWatchState.actual, newActual)) {
            actualWatchMoves.push({
              oldActual: subscriberWatchState.actual,
              newActual,
              count: subscriberWatchState.count,
            });
            subscriberWatchState.actual = newActual;
          }
        }
      }

      if (changedPaths.length > 0) {
        const tx = subscriber.tx.clone();
        if (tx !== null) subscribersToNotify.push({ tx, changedPaths });
      }
    }

    for (const move of actualWatchMoves) {
      this.applyActualWatchMove(move.oldActual, move.newActual, move.count);
    }

    for (const { tx, changedPaths } of subscribersToNotify) {
      try {
        await tx.addChangedPaths(changedPaths);
      } finally {
        tx.close();
      }
    }
  }
}

export function isMutatingEvent(event: FileWatcherRawEvent): boolean {
  return event.kind === "change" || event.kind === "create" || event.kind === "modify" || event.kind === "remove" || event.kind === "rename";
}

function dedupeWatchedPaths(watchedPaths: readonly WatchPath[]): WatchPath[] {
  const sorted = [...watchedPaths].sort((a, b) => {
    const pathComparison = a.path.localeCompare(b.path);
    if (pathComparison !== 0) return pathComparison;
    return Number(a.recursive) - Number(b.recursive);
  });
  const deduped: WatchPath[] = [];
  for (const watchPath of sorted) {
    const previous = deduped.at(-1);
    if (previous === undefined || !watchPathEquals(previous, watchPath)) {
      deduped.push(watchPath);
    }
  }
  return deduped;
}

function actualWatchPath(requested: WatchPath): ActualWatchPathResult {
  if (pathExists(requested.path)) {
    return {
      actual: requested,
      matched: {
        path: canonicalOrSame(requested.path),
        recursive: requested.recursive,
      },
      fallback: false,
    };
  }

  let ancestor = parentPath(requested.path);
  while (ancestor !== null) {
    if (isDirectory(ancestor)) {
      const canonicalAncestor = canonicalOrSame(ancestor);
      const suffix = relativeSuffix(ancestor, requested.path);
      return {
        actual: { path: ancestor, recursive: false },
        matched: {
          path: suffix === null ? requested.path : path.join(canonicalAncestor, suffix),
          recursive: requested.recursive,
        },
        fallback: true,
      };
    }
    ancestor = parentPath(ancestor);
  }

  return { actual: requested, matched: requested, fallback: false };
}

function changedPathForEvent(
  subscriberWatch: SubscriberWatchKey,
  subscriberWatchState: SubscriberWatchState,
  eventPath: string,
): string | null {
  const canonicalMatch = changedPathForMatchedPath(
    subscriberWatch,
    subscriberWatchState,
    subscriberWatch.matched,
    eventPath,
  );
  if (canonicalMatch !== null) return canonicalMatch;
  if (pathsEqual(subscriberWatch.matched.path, subscriberWatch.requested.path)) return null;
  return changedPathForMatchedPath(subscriberWatch, subscriberWatchState, subscriberWatch.requested, eventPath);
}

function changedPathForMatchedPath(
  subscriberWatch: SubscriberWatchKey,
  subscriberWatchState: SubscriberWatchState,
  matched: WatchPath,
  eventPath: string,
): string | null {
  const requested = subscriberWatch.requested;
  if (pathsEqual(eventPath, matched.path)) {
    subscriberWatchState.lastExists = pathExists(matched.path);
    return requested.path;
  }

  if (isPathPrefix(matched.path, eventPath)) {
    const nowExists = pathExists(matched.path);
    if (subscriberWatchState.fallback) {
      const shouldNotify = nowExists || subscriberWatchState.lastExists;
      subscriberWatchState.lastExists = nowExists;
      return shouldNotify ? requested.path : null;
    }
    if (!pathsEqual(subscriberWatchState.actual.path, matched.path)) {
      const shouldNotify = nowExists || subscriberWatchState.lastExists;
      subscriberWatchState.lastExists = nowExists;
      return shouldNotify ? requested.path : null;
    }
    subscriberWatchState.lastExists = nowExists;
    return eventPath;
  }

  if (!isPathPrefix(eventPath, matched.path)) return null;
  if (!(matched.recursive || parentEquals(eventPath, matched.path))) return null;

  subscriberWatchState.lastExists = pathExists(matched.path);
  const suffix = relativeSuffix(matched.path, eventPath);
  return suffix === null ? eventPath : path.join(requested.path, suffix);
}

function getOrInsertCounts(countsByPath: Map<string, PathWatchCounts>, pathToWatch: string): PathWatchCounts {
  let counts = countsByPath.get(pathToWatch);
  if (counts === undefined) {
    counts = new PathWatchCounts();
    countsByPath.set(pathToWatch, counts);
  }
  return counts;
}

function subscriberWatchKeyId(key: SubscriberWatchKey): string {
  return `${key.requested.path}\0${key.requested.recursive ? "1" : "0"}\0${key.matched.path}\0${key.matched.recursive ? "1" : "0"}`;
}

function watchPathEquals(a: WatchPath, b: WatchPath): boolean {
  return a.recursive === b.recursive && a.path === b.path;
}

function recursiveDirectories(root: string): string[] {
  if (!isDirectory(root)) return [];

  const directories = [root];
  for (let index = 0; index < directories.length; index += 1) {
    const current = directories[index];
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      directories.push(path.join(current, entry.name));
    }
  }
  return directories;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pathExists(pathToCheck: string): boolean {
  return existsSync(pathToCheck);
}

function isDirectory(pathToCheck: string): boolean {
  try {
    return statSync(pathToCheck).isDirectory();
  } catch {
    return false;
  }
}

function canonicalOrSame(pathToCanonicalize: string): string {
  try {
    return realpathSync.native(pathToCanonicalize);
  } catch {
    try {
      return realpathSync(pathToCanonicalize);
    } catch {
      return pathToCanonicalize;
    }
  }
}

function parentPath(pathToInspect: string): string | null {
  const parent = path.dirname(pathToInspect);
  return parent === pathToInspect ? null : parent;
}

function pathsEqual(a: string, b: string): boolean {
  return path.normalize(a) === path.normalize(b);
}

function isPathPrefix(child: string, ancestor: string): boolean {
  if (pathsEqual(child, ancestor)) return true;
  const relative = path.relative(ancestor, child);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function parentEquals(child: string, expectedParent: string): boolean {
  return pathsEqual(path.dirname(child), expectedParent);
}

function relativeSuffix(prefix: string, target: string): string | null {
  if (!isPathPrefix(target, prefix)) return null;
  const suffix = path.relative(prefix, target);
  return suffix.length === 0 ? "" : suffix;
}
