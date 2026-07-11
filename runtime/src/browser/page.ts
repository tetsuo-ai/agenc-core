/**
 * A single browser tab: one CDP target/session with navigation, snapshotting,
 * and ref-addressed actions.
 *
 * SSRF is enforced upstream by the loopback proxy every request flows through
 * (`proxy.ts`), so this module does no address checking of its own beyond the
 * synchronous scheme/credential validation in {@link validateNavigableUrl}.
 * When the proxy refuses the navigated host, `navigate()` surfaces the proxy's
 * precise block reason instead of a generic load failure.
 *
 * @module
 */

import type { CdpConnection } from "./cdp.js";
import { validateNavigableUrl } from "./ssrf.js";
import {
  formatSnapshot,
  RefRegistry,
  type AXNode,
  type SnapshotResult,
} from "./snapshot.js";

/** Reports (and consumes) the most recent proxy block reason for a host. */
export type BlockReporter = (host: string) => string | undefined;

export interface BrowserPageOptions {
  readonly connection: CdpConnection;
  readonly targetId: string;
  readonly sessionId: string;
  readonly navigationTimeoutMs: number;
  readonly blockReporter?: BlockReporter;
}

export class BrowserActionError extends Error {
  readonly code = "BROWSER_ACTION_ERROR";
  constructor(message: string) {
    super(message);
    this.name = "BrowserActionError";
  }
}

interface NamedKey {
  readonly keyCode: number;
  readonly key: string;
  readonly code: string;
  readonly text?: string;
}

const NAMED_KEYS: Readonly<Record<string, NamedKey>> = {
  Enter: { keyCode: 13, key: "Enter", code: "Enter", text: "\r" },
  Tab: { keyCode: 9, key: "Tab", code: "Tab" },
  Escape: { keyCode: 27, key: "Escape", code: "Escape" },
  Backspace: { keyCode: 8, key: "Backspace", code: "Backspace" },
  Delete: { keyCode: 46, key: "Delete", code: "Delete" },
  ArrowUp: { keyCode: 38, key: "ArrowUp", code: "ArrowUp" },
  ArrowDown: { keyCode: 40, key: "ArrowDown", code: "ArrowDown" },
  ArrowLeft: { keyCode: 37, key: "ArrowLeft", code: "ArrowLeft" },
  ArrowRight: { keyCode: 39, key: "ArrowRight", code: "ArrowRight" },
  PageUp: { keyCode: 33, key: "PageUp", code: "PageUp" },
  PageDown: { keyCode: 34, key: "PageDown", code: "PageDown" },
  Home: { keyCode: 36, key: "Home", code: "Home" },
  End: { keyCode: 35, key: "End", code: "End" },
};

export class BrowserPage {
  readonly #conn: CdpConnection;
  readonly #targetId: string;
  readonly #sessionId: string;
  readonly #navTimeout: number;
  readonly #blockReporter: BlockReporter | undefined;
  readonly #refRegistry = new RefRegistry();
  #refToBackendId: ReadonlyMap<string, number> = new Map();
  #disposeNav: () => void = () => {};

  constructor(options: BrowserPageOptions) {
    this.#conn = options.connection;
    this.#targetId = options.targetId;
    this.#sessionId = options.sessionId;
    this.#navTimeout = options.navigationTimeoutMs;
    this.#blockReporter = options.blockReporter;
  }

  get targetId(): string {
    return this.#targetId;
  }

  async init(): Promise<void> {
    await this.#send("Page.enable");
    await this.#send("Runtime.enable");
    await this.#send("DOM.enable");
    // Reset refs whenever the main frame finishes a fresh load.
    this.#disposeNav = this.#conn.on(
      this.#sessionId,
      "Page.frameStoppedLoading",
      () => this.#refRegistry.reset(),
    );
  }

  #send(
    method: string,
    params: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.#conn.send(method, params, this.#sessionId, {
      ...(signal !== undefined ? { signal } : {}),
    });
  }

  /**
   * Navigate to a URL and wait for load. SSRF enforcement is at the proxy;
   * this always consults the proxy's authoritative block record after the
   * attempt, because a blocked HTTP target returns a 403 *page* that loads
   * without a CDP navigation error (only HTTPS CONNECT refusals surface as
   * `errorText`). A recorded block for the navigated host always wins.
   */
  async navigate(url: string, signal?: AbortSignal): Promise<void> {
    const parsed = validateNavigableUrl(url);
    this.#refRegistry.reset();
    const result = await this.#send("Page.navigate", { url }, signal);
    const errorText = result.errorText as string | undefined;
    if (errorText === undefined || errorText === "") {
      try {
        await this.#conn.waitFor(this.#sessionId, "Page.loadEventFired", {
          timeoutMs: this.#navTimeout,
          ...(signal !== undefined ? { signal } : {}),
        });
      } catch {
        // Some pages never fire load (long-poll, streaming); fall through to
        // the block check and, if clean, treat as best-effort success.
      }
    }
    const blocked = this.#blockReporter?.(parsed.hostname);
    if (blocked !== undefined) {
      throw new BrowserActionError(`navigation blocked: ${blocked}`);
    }
    if (errorText !== undefined && errorText !== "") {
      throw new BrowserActionError(`navigation failed: ${errorText} (${url})`);
    }
  }

  /** Capture and format the accessibility snapshot. */
  async snapshot(signal?: AbortSignal): Promise<string> {
    const result = await this.#send("Accessibility.getFullAXTree", {}, signal);
    const nodes = (result.nodes as AXNode[] | undefined) ?? [];
    const formatted: SnapshotResult = formatSnapshot(nodes, this.#refRegistry);
    this.#refToBackendId = formatted.refToBackendId;
    return formatted.text;
  }

  #resolveRef(ref: string): number {
    const backendId = this.#refToBackendId.get(ref);
    if (backendId === undefined) {
      throw new BrowserActionError(
        `unknown ref "${ref}" — take a snapshot first, then use a ref from it`,
      );
    }
    return backendId;
  }

  async #centerOf(
    backendNodeId: number,
    signal?: AbortSignal,
  ): Promise<{ x: number; y: number }> {
    await this.#send(
      "DOM.scrollIntoViewIfNeeded",
      { backendNodeId },
      signal,
    ).catch(() => {});
    const quads = await this.#send(
      "DOM.getContentQuads",
      { backendNodeId },
      signal,
    );
    const quadList = quads.quads as number[][] | undefined;
    const quad = quadList?.[0];
    if (quad === undefined || quad.length < 8) {
      throw new BrowserActionError("element is not visible or has no layout box");
    }
    const x = (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4;
    const y = (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4;
    return { x, y };
  }

  /**
   * Wait briefly to see whether the last action started a navigation; if so,
   * wait for it to finish (up to the navigation timeout) so a follow-up
   * snapshot reflects the destination page. No-op when nothing navigates.
   */
  async #settleNavigation(signal?: AbortSignal): Promise<void> {
    const started = await this.#raceEvent("Page.frameStartedLoading", 600, signal);
    if (!started) return;
    await this.#conn
      .waitFor(this.#sessionId, "Page.loadEventFired", {
        timeoutMs: this.#navTimeout,
        ...(signal !== undefined ? { signal } : {}),
      })
      .catch(() => {});
    this.#refRegistry.reset();
  }

  /** Resolve true if `method` fires within `ms`, false on timeout. */
  #raceEvent(
    method: string,
    ms: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        dispose();
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const dispose = this.#conn.on(this.#sessionId, method, () => finish(true));
      const timer = setTimeout(() => finish(false), ms);
      timer.unref?.();
      const onAbort = (): void => finish(false);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Click an element by ref. Settles any navigation the click triggers. */
  async click(ref: string, signal?: AbortSignal): Promise<void> {
    const backendNodeId = this.#resolveRef(ref);
    const { x, y } = await this.#centerOf(backendNodeId, signal);
    await this.#send(
      "Input.dispatchMouseEvent",
      { type: "mousePressed", x, y, button: "left", clickCount: 1 },
      signal,
    );
    await this.#send(
      "Input.dispatchMouseEvent",
      { type: "mouseReleased", x, y, button: "left", clickCount: 1 },
      signal,
    );
    await this.#settleNavigation(signal);
  }

  /** Focus an element by ref and type text; optionally submit with Enter. */
  async type(
    ref: string,
    text: string,
    submit: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    const backendNodeId = this.#resolveRef(ref);
    await this.#send("DOM.focus", { backendNodeId }, signal);
    if (text.length > 0) {
      await this.#send("Input.insertText", { text }, signal);
    }
    if (submit) {
      await this.pressKey("Enter", signal);
    }
  }

  /** Dispatch a named key (Enter, Tab, ArrowDown, …). */
  async pressKey(key: string, signal?: AbortSignal): Promise<void> {
    const named = NAMED_KEYS[key];
    if (named === undefined) {
      throw new BrowserActionError(
        `unsupported key "${key}" — supported: ${Object.keys(NAMED_KEYS).join(", ")}`,
      );
    }
    const base = {
      windowsVirtualKeyCode: named.keyCode,
      key: named.key,
      code: named.code,
      ...(named.text !== undefined ? { text: named.text } : {}),
    };
    await this.#send(
      "Input.dispatchKeyEvent",
      { type: named.text !== undefined ? "keyDown" : "rawKeyDown", ...base },
      signal,
    );
    await this.#send("Input.dispatchKeyEvent", { type: "keyUp", ...base }, signal);
    // Enter can submit a form / trigger navigation — settle if it did.
    if (key === "Enter") await this.#settleNavigation(signal);
  }

  /** Scroll the viewport up or down by roughly one page. */
  async scroll(direction: "up" | "down", signal?: AbortSignal): Promise<void> {
    const deltaY = direction === "down" ? 600 : -600;
    await this.#send(
      "Input.dispatchMouseEvent",
      { type: "mouseWheel", x: 200, y: 300, deltaX: 0, deltaY },
      signal,
    );
  }

  /** Capture a screenshot; returns base64 image data + mime type. */
  async screenshot(
    format: "png" | "jpeg",
    fullPage: boolean,
    signal?: AbortSignal,
  ): Promise<{ base64: string; mime: string }> {
    const params: Record<string, unknown> = { format };
    if (format === "jpeg") params.quality = 70;
    if (fullPage) params.captureBeyondViewport = true;
    const result = await this.#send("Page.captureScreenshot", params, signal);
    const data = result.data as string | undefined;
    if (data === undefined) {
      throw new BrowserActionError("screenshot capture returned no data");
    }
    return { base64: data, mime: format === "png" ? "image/png" : "image/jpeg" };
  }

  /** Read the page's visible text (`document.body.innerText`), capped. */
  async getText(maxChars: number, signal?: AbortSignal): Promise<string> {
    const result = await this.#send(
      "Runtime.evaluate",
      {
        expression: "document.body ? document.body.innerText : ''",
        returnByValue: true,
      },
      signal,
    );
    const value = (result.result as { value?: unknown } | undefined)?.value;
    const text = typeof value === "string" ? value : "";
    return text.length > maxChars
      ? `${text.slice(0, maxChars)}\n… (truncated)`
      : text;
  }

  /** Current URL and title. */
  async info(signal?: AbortSignal): Promise<{ url: string; title: string }> {
    const result = await this.#send(
      "Runtime.evaluate",
      {
        expression: "JSON.stringify({url: location.href, title: document.title})",
        returnByValue: true,
      },
      signal,
    );
    const raw = (result.result as { value?: unknown } | undefined)?.value;
    if (typeof raw === "string") {
      try {
        const parsed = JSON.parse(raw) as { url?: string; title?: string };
        return { url: parsed.url ?? "", title: parsed.title ?? "" };
      } catch {
        /* fall through */
      }
    }
    return { url: "", title: "" };
  }

  dispose(): void {
    this.#disposeNav();
  }
}
