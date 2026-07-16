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

const IDLE_SHUTDOWN_MS = 5 * 60 * 1000;
const MAX_TABS = 8;

/** All live managers in this process — closed together on daemon shutdown. */
const activeManagers = new Set<BrowserManager>();

/** Graceful shutdown hook for the daemon cleanup registry. */
export async function closeAllBrowserManagers(): Promise<void> {
  const managers = [...activeManagers];
  await Promise.all(managers.map((manager) => manager.closeAll().catch(() => {})));
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
    if (this.running) {
      this.#touchIdle();
      return;
    }
    if (this.#launching !== undefined) {
      await this.#launching;
      return;
    }
    this.#launching = this.#launch();
    try {
      await this.#launching;
    } finally {
      this.#launching = undefined;
    }
  }

  async #launch(): Promise<void> {
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
      await proxy.stop();
      throw err;
    }

    this.#proxy = proxy;
    this.#child = launched.child;
    this.#connection = launched.connection;
    this.#tabs = [];
    this.#activeTabId = 0;
    launched.child.once("exit", () => {
      if (this.#child === launched.child) this.#teardownState();
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

  #teardownState(): void {
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
    void this.#proxy?.stop();
    this.#proxy = undefined;
    activeManagers.delete(this);
    process.removeListener("exit", this.#exitListener);
  }

  #killNow(): void {
    const child = this.#child;
    this.#teardownState();
    if (child !== undefined && child.exitCode === null) {
      child.kill("SIGKILL");
    }
    if (this.#tempProfileDir !== undefined) {
      rmSync(this.#tempProfileDir, { recursive: true, force: true });
      this.#tempProfileDir = undefined;
    }
  }

  /** Graceful shutdown: SIGTERM, then SIGKILL after 500ms (repo discipline). */
  async closeAll(): Promise<void> {
    // A launch racing shutdown assigns #child only when it finishes; without
    // awaiting it here, a browser started mid-shutdown would survive cleanup
    // (and re-arm its idle timer) after closeAll already returned.
    const launching = this.#launching;
    if (launching !== undefined) await launching.catch(() => {});
    const child = this.#child;
    this.#teardownState();
    if (child === undefined || child.exitCode !== null) {
      this.#cleanupTempProfile();
      return;
    }
    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 500);
      killTimer.unref?.();
      child.once("exit", () => {
        clearTimeout(killTimer);
        resolve();
      });
      child.kill("SIGTERM");
    });
    this.#cleanupTempProfile();
  }

  #cleanupTempProfile(): void {
    if (this.#tempProfileDir !== undefined) {
      rmSync(this.#tempProfileDir, { recursive: true, force: true });
      this.#tempProfileDir = undefined;
    }
  }
}
