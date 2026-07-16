/**
 * Browser session manager: owns the dedicated Chromium child, the loopback
 * SSRF proxy, the CDP connection, and the tab registry for one runtime process.
 *
 * The browser launches lazily on the first action, all egress is forced through
 * the in-process proxy (no independent DNS/connections), a dedicated profile
 * lives under `<agencHome>/browser/profile` (0700 — never the user's real
 * profile), it shuts down after an idle period, and is force-killed on process
 * exit. The daemon calls {@link closeAllBrowserManagers} from its cleanup
 * registry.
 *
 * @module
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ChildProcess } from "node:child_process";
import { CdpConnection, launchBrowser } from "./cdp.js";
import type { SandboxExecutionBrokerLike } from "../sandbox/execution-broker.js";
import { BrowserPage, BrowserActionError } from "./page.js";
import { BrowserProxy } from "./proxy.js";
import { resolveBrowserExecutable } from "./executable.js";
import type { BrowserPolicy } from "./config.js";
import type { HostLookup } from "./ssrf.js";
import {
  signalProcessTree,
  terminateProcessTreeAndWait,
} from "../utils/supervisedProcess.js";

const IDLE_SHUTDOWN_MS = 5 * 60 * 1000;
const MAX_TABS = 8;

/** All live managers in this process — closed together on daemon shutdown. */
const activeManagers = new Set<BrowserManager>();

/** Graceful shutdown hook for the daemon cleanup registry. */
export async function closeAllBrowserManagers(): Promise<void> {
  const managers = [...activeManagers];
  const results = await Promise.allSettled(
    managers.map((manager) => manager.closeAll()),
  );
  const errors = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (errors.length > 0) {
    throw new AggregateError(errors, "browser manager shutdown failed");
  }
}

export interface BrowserManagerOptions {
  readonly agencHome?: string;
  readonly policy: BrowserPolicy;
  /** Authenticated session boundary for the Chromium process. */
  readonly sandboxExecutionBroker?: SandboxExecutionBrokerLike;
  /** Test seam: overrides DNS resolution inside the proxy's SSRF checks. */
  readonly lookup?: HostLookup;
  /** Test seam: overrides idle shutdown delay. */
  readonly idleShutdownMs?: number;
}

export interface TabDescriptor {
  readonly id: number;
  readonly url: string;
  readonly title: string;
  readonly active: boolean;
}

interface TabEntry {
  readonly id: number;
  readonly page: BrowserPage;
}

interface BrowserBoundary {
  child: ChildProcess | undefined;
  proxy: BrowserProxy | undefined;
  readonly label: string;
}

interface RetainedBrowserBoundary {
  readonly boundary: BrowserBoundary;
  failure: Error;
}

export class BrowserManager {
  readonly #options: BrowserManagerOptions;
  #child: ChildProcess | undefined;
  #connection: CdpConnection | undefined;
  #proxy: BrowserProxy | undefined;
  #tabs: TabEntry[] = [];
  #activeTabId = 0;
  #nextTabId = 1;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  #launching: Promise<void> | undefined;
  #closing: Promise<void> | undefined;
  #processCleanup: Promise<void> | undefined;
  #retainedBoundaries: RetainedBrowserBoundary[] = [];
  #shutdownGeneration = 0;
  #launchAuthorityCwd: string | undefined;
  #tempProfileDir: string | undefined;
  readonly #exitListener = (): void => {
    this.#killNow();
  };

  constructor(options: BrowserManagerOptions) {
    this.#options = options;
  }

  get running(): boolean {
    return this.#connection !== undefined && !this.#connection.closed;
  }

  /**
   * Resolve the profile dir and ensure it exists (0700). The fallback uses
   * `mkdtempSync` rather than a predictable `<tmpdir>/agenc-browser-<pid>-<ts>`
   * path: on a shared host that predictable name lets a local attacker
   * pre-create (or symlink) the directory so Chromium reuses an
   * attacker-readable profile — `mkdtempSync` always creates a fresh,
   * unpredictable 0700 directory and never reuses an existing one.
   */
  #ensureProfileDir(): string {
    // Child sessions get an ephemeral profile. Sharing the root session's
    // persistent cookies/storage across independently sandboxed browser
    // processes would silently collapse their authority boundary.
    if ((this.#options.sandboxExecutionBroker?.forkDepth ?? 0) > 0) {
      if (this.#tempProfileDir === undefined) {
        this.#tempProfileDir = mkdtempSync(join(tmpdir(), "agenc-browser-child-"));
      }
      return this.#tempProfileDir;
    }
    const configured = this.#options.policy.profileDir;
    if (configured !== undefined) {
      mkdirSync(configured, { recursive: true, mode: 0o700 });
      return configured;
    }
    if (this.#options.agencHome !== undefined) {
      const dir = join(this.#options.agencHome, "browser", "profile");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      return dir;
    }
    if (this.#tempProfileDir === undefined) {
      this.#tempProfileDir = mkdtempSync(join(tmpdir(), "agenc-browser-"));
    }
    return this.#tempProfileDir;
  }

  async #ensureLaunched(): Promise<void> {
    const requestGeneration = this.#shutdownGeneration;
    while (true) {
      if (requestGeneration !== this.#shutdownGeneration) {
        throw new BrowserActionError("browser launch was interrupted by shutdown");
      }
      if (this.#closing !== undefined) {
        await this.#closing;
        continue;
      }
      await this.#awaitProcessCleanup();
      const brokerCwd = this.#options.sandboxExecutionBroker?.cwd;
      if (
        this.running &&
        brokerCwd !== undefined &&
        this.#launchAuthorityCwd !== brokerCwd
      ) {
        await this.closeAll();
        continue;
      }
      if (this.running) {
        this.#touchIdle();
        return;
      }
      if (this.#launching !== undefined) {
        await this.#launching;
        continue;
      }
      const generation = this.#shutdownGeneration;
      const launching = this.#launch(generation);
      this.#launching = launching;
      try {
        await launching;
      } finally {
        if (this.#launching === launching) this.#launching = undefined;
      }
    }
  }

  async #launch(generation: number): Promise<void> {
    const authorityCwd = this.#options.sandboxExecutionBroker?.cwd;
    const proxy = new BrowserProxy({
      policy: { allowPrivateNetwork: this.#options.policy.allowPrivateNetwork },
      ...(this.#options.lookup !== undefined
        ? { lookup: this.#options.lookup }
        : {}),
    });
    const proxyPort = await proxy.start();

    // Everything after the proxy is listening must stop it on failure, or the
    // loopback listener leaks (and every retried action leaks another). This
    // includes profile-dir creation, which can throw on a bad profile_dir.
    let launched;
    try {
      const executablePath = resolveBrowserExecutable(
        this.#options.policy.executablePath,
      );
      const userDataDir = this.#ensureProfileDir();
      launched = await launchBrowser({
        executablePath,
        userDataDir,
        headless: this.#options.policy.headless,
        noSandbox: this.#options.policy.noSandbox,
        proxyPort,
        ...(this.#options.sandboxExecutionBroker !== undefined
          ? { sandboxExecutionBroker: this.#options.sandboxExecutionBroker }
          : {}),
      });
    } catch (err) {
      const boundary: BrowserBoundary = {
        child: undefined,
        proxy,
        label: "failed browser launch",
      };
      try {
        await this.#cleanupOwnedBoundary(boundary);
      } catch (cleanupError) {
        throw new AggregateError(
          [err, cleanupError],
          "browser launch cleanup failed",
        );
      }
      throw err;
    }

    if (
      generation !== this.#shutdownGeneration ||
      authorityCwd !== this.#options.sandboxExecutionBroker?.cwd
    ) {
      launched.connection.close();
      await this.#cleanupOwnedBoundary({
        child: launched.child,
        proxy,
        label: "stale browser launch",
      });
      return;
    }

    this.#proxy = proxy;
    this.#child = launched.child;
    this.#connection = launched.connection;
    this.#launchAuthorityCwd = authorityCwd;
    this.#tabs = [];
    this.#activeTabId = 0;
    launched.child.once("exit", () => {
      if (this.#child === launched.child) {
        const stoppedProxy = this.#teardownState();
        this.#trackUnexpectedCleanup({
          child: launched.child,
          proxy: stoppedProxy,
          label: "browser after unexpected exit",
        });
      }
    });
    process.once("exit", this.#exitListener);
    activeManagers.add(this);
    this.#touchIdle();
  }

  #touchIdle(): void {
    if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer);
    const delay = this.#options.idleShutdownMs ?? IDLE_SHUTDOWN_MS;
    this.#idleTimer = setTimeout(() => {
      void this.closeAll();
    }, delay);
    this.#idleTimer.unref?.();
  }

  async #createTab(url: string): Promise<TabEntry> {
    const connection = this.#connection;
    const proxy = this.#proxy;
    if (connection === undefined || proxy === undefined) {
      throw new BrowserActionError("browser is not running");
    }
    if (this.#tabs.length >= MAX_TABS) {
      throw new BrowserActionError(
        `too many open tabs (max ${MAX_TABS}) — close one first`,
      );
    }
    const created = await connection.send("Target.createTarget", {
      url: "about:blank",
    });
    const targetId = created.targetId as string;
    const attached = await connection.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    const sessionId = attached.sessionId as string;
    const page = new BrowserPage({
      connection,
      targetId,
      sessionId,
      navigationTimeoutMs: this.#options.policy.navigationTimeoutMs,
      blockReporter: (host) => proxy.takeBlockReason(host),
    });
    await page.init();
    if (url !== "about:blank" && url !== "") {
      await page.navigate(url);
    }
    const entry: TabEntry = { id: this.#nextTabId++, page };
    this.#tabs.push(entry);
    this.#activeTabId = entry.id;
    return entry;
  }

  #tabById(tabId: number | undefined): TabEntry {
    if (this.#tabs.length === 0) {
      throw new BrowserActionError(
        "no open tabs — use the navigate action to open a page first",
      );
    }
    const id = tabId ?? this.#activeTabId;
    const entry = this.#tabs.find((tab) => tab.id === id);
    if (entry === undefined) {
      throw new BrowserActionError(
        `no tab with id ${id} — use the tabs action to list open tabs`,
      );
    }
    return entry;
  }

  /** Navigate the active tab (creating one if needed) or `tabId`. */
  async navigate(
    url: string,
    tabId?: number,
    signal?: AbortSignal,
  ): Promise<BrowserPage> {
    await this.#ensureLaunched();
    this.#touchIdle();
    if (this.#tabs.length === 0 && tabId === undefined) {
      const entry = await this.#createTab(url);
      return entry.page;
    }
    const entry = this.#tabById(tabId);
    this.#activeTabId = entry.id;
    await entry.page.navigate(url, signal);
    return entry.page;
  }

  /** Open a new tab, optionally navigating it. */
  async newTab(url?: string, signal?: AbortSignal): Promise<TabDescriptor> {
    await this.#ensureLaunched();
    this.#touchIdle();
    const entry = await this.#createTab(url ?? "about:blank");
    const info = await entry.page.info(signal);
    return { id: entry.id, url: info.url, title: info.title, active: true };
  }

  /** Get the page for an action; throws when there are no tabs. */
  async page(tabId?: number): Promise<BrowserPage> {
    await this.#ensureLaunched();
    this.#touchIdle();
    const entry = this.#tabById(tabId);
    this.#activeTabId = entry.id;
    return entry.page;
  }

  async listTabs(signal?: AbortSignal): Promise<TabDescriptor[]> {
    if (!this.running) return [];
    this.#touchIdle();
    const out: TabDescriptor[] = [];
    for (const entry of this.#tabs) {
      const info = await entry.page.info(signal);
      out.push({
        id: entry.id,
        url: info.url,
        title: info.title,
        active: entry.id === this.#activeTabId,
      });
    }
    return out;
  }

  async closeTab(tabId: number): Promise<void> {
    const connection = this.#connection;
    if (connection === undefined) return;
    const entry = this.#tabById(tabId);
    entry.page.dispose();
    await connection
      .send("Target.closeTarget", { targetId: entry.page.targetId })
      .catch(() => {});
    this.#tabs = this.#tabs.filter((tab) => tab.id !== entry.id);
    if (this.#activeTabId === entry.id) {
      this.#activeTabId = this.#tabs.at(-1)?.id ?? 0;
    }
    this.#touchIdle();
  }

  selectTab(tabId: number): void {
    const entry = this.#tabById(tabId);
    this.#activeTabId = entry.id;
    this.#touchIdle();
  }

  #teardownState(): BrowserProxy | undefined {
    if (this.#idleTimer !== undefined) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = undefined;
    }
    for (const entry of this.#tabs) entry.page.dispose();
    this.#tabs = [];
    this.#activeTabId = 0;
    this.#connection?.close();
    this.#connection = undefined;
    this.#child = undefined;
    this.#launchAuthorityCwd = undefined;
    const proxy = this.#proxy;
    this.#proxy = undefined;
    activeManagers.delete(this);
    process.removeListener("exit", this.#exitListener);
    return proxy;
  }

  #killNow(): void {
    const child = this.#child;
    const proxy = this.#teardownState();
    void proxy?.stop();
    if (child !== undefined) {
      signalProcessTree(child, "SIGKILL");
    }
    for (const { boundary } of this.#retainedBoundaries) {
      if (boundary.child !== undefined) {
        signalProcessTree(boundary.child, "SIGKILL");
      }
      void boundary.proxy?.stop();
    }
    if (this.#tempProfileDir !== undefined) {
      rmSync(this.#tempProfileDir, { recursive: true, force: true });
      this.#tempProfileDir = undefined;
    }
  }

  /** Graceful, bounded shutdown that proves the whole process tree exited. */
  closeAll(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    this.#shutdownGeneration += 1;
    let closing!: Promise<void>;
    closing = this.#closeAllOnce().finally(() => {
      if (this.#closing === closing) this.#closing = undefined;
    });
    this.#closing = closing;
    return closing;
  }

  async #closeAllOnce(): Promise<void> {
    const errors: unknown[] = [];
    // A launch racing shutdown assigns #child only when it finishes; without
    // awaiting it here, a browser started mid-shutdown would survive cleanup
    // (and re-arm its idle timer) after closeAll already returned.
    const launching = this.#launching;
    if (launching !== undefined) {
      try {
        await launching;
      } catch (error) {
        errors.push(error);
      }
    }
    if (this.#processCleanup !== undefined) await this.#processCleanup;
    try {
      await this.#retryRetainedBoundaries();
    } catch (error) {
      errors.push(error);
    }
    const child = this.#child;
    const proxy = this.#teardownState();
    try {
      await this.#cleanupOwnedBoundary({ child, proxy, label: "browser" });
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "browser shutdown failed");
    }
  }

  async #awaitProcessCleanup(): Promise<void> {
    if (this.#processCleanup !== undefined) await this.#processCleanup;
    if (this.#retainedBoundaries.length === 1) {
      throw this.#retainedBoundaries[0]!.failure;
    }
    if (this.#retainedBoundaries.length > 1) {
      throw new AggregateError(
        this.#retainedBoundaries.map(({ failure }) => failure),
        "browser boundary cleanup remains incomplete",
      );
    }
  }

  #trackUnexpectedCleanup(boundary: BrowserBoundary): void {
    // Keep daemon shutdown aware of this manager until its orphan-resistant
    // cleanup has settled, even though the CDP state is already torn down.
    activeManagers.add(this);
    let tracked!: Promise<void>;
    tracked = this.#cleanupOwnedBoundary(boundary)
      .catch(() => {
        // #cleanupOwnedBoundary retains the failed ownership record. The next
        // action observes that poison; an explicit close retries it.
      })
      .finally(() => {
        if (this.#processCleanup === tracked) this.#processCleanup = undefined;
        if (
          this.#retainedBoundaries.length === 0 &&
          this.#child === undefined
        ) {
          activeManagers.delete(this);
        }
      });
    this.#processCleanup = tracked;
  }

  async #cleanupOwnedBoundary(boundary: BrowserBoundary): Promise<void> {
    const errors: unknown[] = [];
    if (boundary.child !== undefined) {
      try {
        await terminateProcessTreeAndWait(boundary.child, {
          label: boundary.label,
        });
        boundary.child = undefined;
      } catch (error) {
        errors.push(error);
      }
    }
    if (boundary.proxy !== undefined) {
      try {
        await boundary.proxy.stop();
        boundary.proxy = undefined;
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      this.#cleanupTempProfile();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 0) return;
    const failure = errors.length === 1
      ? toError(errors[0])
      : new AggregateError(errors, `${boundary.label} cleanup failed`);
    this.#retainBoundary(boundary, failure);
    throw failure;
  }

  #retainBoundary(boundary: BrowserBoundary, failure: Error): void {
    const retained = this.#retainedBoundaries.find(
      (candidate) => candidate.boundary === boundary,
    );
    if (retained !== undefined) retained.failure = failure;
    else this.#retainedBoundaries.push({ boundary, failure });
    activeManagers.add(this);
  }

  async #retryRetainedBoundaries(): Promise<void> {
    const failures: unknown[] = [];
    for (const retained of [...this.#retainedBoundaries]) {
      try {
        await this.#cleanupOwnedBoundary(retained.boundary);
        const index = this.#retainedBoundaries.indexOf(retained);
        if (index >= 0) this.#retainedBoundaries.splice(index, 1);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "browser boundary retry failed");
    }
  }

  #cleanupTempProfile(): void {
    if (this.#tempProfileDir !== undefined) {
      rmSync(this.#tempProfileDir, { recursive: true, force: true });
      this.#tempProfileDir = undefined;
    }
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
