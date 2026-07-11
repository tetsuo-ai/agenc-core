/**
 * `Browser` — a unified, ref-addressed browser-automation tool backed by an
 * isolated Chromium instance driven over a CDP pipe, with all egress forced
 * through the SSRF policy proxy (`browser/`).
 *
 * Deferred by default (heavy specialist tool, discovered via
 * `system.searchTools`). Read-only actions are auto-approved; navigation and
 * acting actions surface a permission preview in default mode. Screenshots are
 * returned as in-memory image content items — the tool performs no
 * arg-directed filesystem writes, which is why `virtualNoFsWrites` is set (see
 * the audit note on the metadata field).
 *
 * @module
 */

import type { Tool, ToolExecutionInjectedArgs, ToolResult } from "../types.js";
import type { FunctionCallOutputContentItem } from "../context.js";
import type { PermissionResult, PermissionUpdate } from "../../permissions/types.js";
import type { ToolEvaluatorContext } from "../../permissions/evaluator.js";
import { getRuleByContentsForTool } from "../../permissions/rules.js";
import { BrowserManager } from "../../browser/manager.js";
import { resolveBrowserPolicy } from "../../browser/config.js";
import { loadConfig } from "../../config/loader.js";
import { resolveAgencHome } from "../../config/env.js";
import {
  BROWSER_TOOL_NAME,
  BROWSER_TOOL_DESCRIPTION,
  BROWSER_READ_ONLY_ACTIONS,
} from "./prompt.js";

const BROWSER_ACTIONS = [
  "navigate",
  "snapshot",
  "click",
  "type",
  "press_key",
  "scroll",
  "screenshot",
  "get_text",
  "new_tab",
  "tabs",
  "select_tab",
  "close_tab",
] as const;

const GET_TEXT_DEFAULT_MAX = 20_000;
const GET_TEXT_HARD_MAX = 100_000;

interface BrowserToolInput extends ToolExecutionInjectedArgs {
  readonly action?: unknown;
  readonly url?: unknown;
  readonly ref?: unknown;
  readonly text?: unknown;
  readonly submit?: unknown;
  readonly key?: unknown;
  readonly direction?: unknown;
  readonly format?: unknown;
  readonly full_page?: unknown;
  readonly tab_id?: unknown;
  readonly max_chars?: unknown;
}

export interface CreateBrowserToolOptions {
  /** Override AGENC_HOME resolution (tests / embedding). */
  readonly agencHome?: string;
  /** Inject a manager (tests). When absent one is created lazily. */
  readonly manager?: BrowserManager;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function errorResult(message: string): ToolResult {
  return { content: message, isError: true };
}

function safeAgencHome(explicit?: string): string | undefined {
  if (explicit !== undefined) return explicit;
  try {
    return resolveAgencHome(process.env);
  } catch {
    return undefined;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function navigateRuleContent(input: unknown): string {
  const url = str((input as { url?: unknown }).url);
  if (url === undefined) return "input:missing-url";
  const host = hostOf(url);
  return host !== "" ? `domain:${host}` : `input:${url.slice(0, 100)}`;
}

function navigateSuggestions(ruleContent: string): readonly PermissionUpdate[] {
  return [
    {
      type: "addRules",
      destination: "localSettings",
      rules: [{ toolName: BROWSER_TOOL_NAME, ruleContent }],
      behavior: "allow",
    },
  ];
}

function describeAction(input: BrowserToolInput): string {
  const action = str(input.action) ?? "act";
  switch (action) {
    case "navigate":
      return `open ${str(input.url) ?? "a page"}`;
    case "click":
      return `click ${str(input.ref) ?? "an element"}`;
    case "type":
      return `type into ${str(input.ref) ?? "an element"}`;
    case "press_key":
      return `press ${str(input.key) ?? "a key"}`;
    case "new_tab":
      return `open a new tab${input.url !== undefined ? ` at ${str(input.url)}` : ""}`;
    default:
      return `run browser action "${action}"`;
  }
}

export function createBrowserTool(
  options: CreateBrowserToolOptions = {},
): Tool {
  let manager: BrowserManager | undefined = options.manager;
  let initializing: Promise<BrowserManager> | undefined;

  async function ensureManager(): Promise<BrowserManager> {
    if (manager !== undefined) return manager;
    if (initializing !== undefined) return initializing;
    initializing = (async () => {
      let browserConfig;
      try {
        const loaded = await loadConfig();
        browserConfig = loaded.config.browser;
      } catch {
        browserConfig = undefined;
      }
      const policy = resolveBrowserPolicy(browserConfig, process.env);
      const agencHome = safeAgencHome(options.agencHome);
      const created = new BrowserManager({
        ...(agencHome !== undefined ? { agencHome } : {}),
        policy,
      });
      manager = created;
      return created;
    })();
    try {
      return await initializing;
    } finally {
      initializing = undefined;
    }
  }

  /** Validate required args before any config/manager work. */
  function validateRequired(
    action: string,
    input: BrowserToolInput,
  ): string | undefined {
    switch (action) {
      case "navigate":
        return str(input.url) === undefined ? "navigate requires a url" : undefined;
      case "click":
        return str(input.ref) === undefined ? "click requires a ref" : undefined;
      case "type":
        return str(input.ref) === undefined ? "type requires a ref" : undefined;
      case "press_key":
        return str(input.key) === undefined ? "press_key requires a key" : undefined;
      case "select_tab":
        return tabIdOf(input) === undefined ? "select_tab requires tab_id" : undefined;
      case "close_tab":
        return tabIdOf(input) === undefined ? "close_tab requires tab_id" : undefined;
      default:
        return undefined;
    }
  }

  async function dispatch(
    input: BrowserToolInput,
    signal: AbortSignal | undefined,
  ): Promise<ToolResult> {
    const action = str(input.action);
    if (action === undefined || !BROWSER_ACTIONS.includes(action as never)) {
      return errorResult(
        `action must be one of: ${BROWSER_ACTIONS.join(", ")}`,
      );
    }
    const requiredError = validateRequired(action, input);
    if (requiredError !== undefined) return errorResult(requiredError);
    const mgr = await ensureManager();

    switch (action) {
      case "navigate": {
        const url = str(input.url)!;
        const page = await mgr.navigate(url, tabIdOf(input), signal);
        const snapshot = await page.snapshot(signal);
        const info = await page.info(signal);
        return {
          content: `Navigated to ${info.url}\n${info.title !== "" ? `Title: ${info.title}\n` : ""}\n${snapshot}`,
          metadata: { action, url: info.url, title: info.title },
        };
      }
      case "snapshot": {
        const page = await mgr.page(tabIdOf(input));
        const snapshot = await page.snapshot(signal);
        return { content: snapshot, metadata: { action } };
      }
      case "click": {
        const ref = str(input.ref)!;
        const page = await mgr.page(tabIdOf(input));
        await page.click(ref, signal);
        const snapshot = await page.snapshot(signal);
        return {
          content: `Clicked ${ref}.\n\n${snapshot}`,
          metadata: { action, ref },
        };
      }
      case "type": {
        const ref = str(input.ref)!;
        const text = typeof input.text === "string" ? input.text : "";
        const submit = input.submit === true;
        const page = await mgr.page(tabIdOf(input));
        await page.type(ref, text, submit, signal);
        const snapshot = await page.snapshot(signal);
        return {
          content: `Typed into ${ref}${submit ? " and submitted" : ""}.\n\n${snapshot}`,
          metadata: { action, ref, submit },
        };
      }
      case "press_key": {
        const key = str(input.key)!;
        const page = await mgr.page(tabIdOf(input));
        await page.pressKey(key, signal);
        const snapshot = await page.snapshot(signal);
        return {
          content: `Pressed ${key}.\n\n${snapshot}`,
          metadata: { action, key },
        };
      }
      case "scroll": {
        const direction = input.direction === "up" ? "up" : "down";
        const page = await mgr.page(tabIdOf(input));
        await page.scroll(direction, signal);
        const snapshot = await page.snapshot(signal);
        return {
          content: `Scrolled ${direction}.\n\n${snapshot}`,
          metadata: { action, direction },
        };
      }
      case "screenshot": {
        const format = input.format === "jpeg" ? "jpeg" : "png";
        const fullPage = input.full_page === true;
        const page = await mgr.page(tabIdOf(input));
        const shot = await page.screenshot(format, fullPage, signal);
        const info = await page.info(signal);
        const contentItems: FunctionCallOutputContentItem[] = [
          { type: "input_text", text: `Screenshot of ${info.url}` },
          {
            type: "input_image",
            image_url: `data:${shot.mime};base64,${shot.base64}`,
          },
        ];
        return {
          content: `Captured a ${format} screenshot of ${info.url}`,
          contentItems,
          metadata: { action, format, url: info.url },
        };
      }
      case "get_text": {
        const max = clampMax(input.max_chars);
        const page = await mgr.page(tabIdOf(input));
        const text = await page.getText(max, signal);
        return { content: text, metadata: { action } };
      }
      case "new_tab": {
        const tab = await mgr.newTab(str(input.url), signal);
        return {
          content: `Opened tab ${tab.id}${tab.url !== "" ? ` at ${tab.url}` : ""}.`,
          metadata: { action, tabId: tab.id },
        };
      }
      case "tabs": {
        const tabs = await mgr.listTabs(signal);
        const lines = tabs.map(
          (tab) =>
            `${tab.active ? "*" : " "} [${tab.id}] ${tab.title || "(untitled)"} — ${tab.url || "about:blank"}`,
        );
        return {
          content: tabs.length > 0 ? lines.join("\n") : "No open tabs.",
          metadata: { action, count: tabs.length },
        };
      }
      case "select_tab": {
        const tabId = tabIdOf(input)!;
        mgr.selectTab(tabId);
        return { content: `Selected tab ${tabId}.`, metadata: { action, tabId } };
      }
      case "close_tab": {
        const tabId = tabIdOf(input)!;
        await mgr.closeTab(tabId);
        return { content: `Closed tab ${tabId}.`, metadata: { action, tabId } };
      }
      default:
        return errorResult(`unsupported action: ${action}`);
    }
  }

  return {
    name: BROWSER_TOOL_NAME,
    description: BROWSER_TOOL_DESCRIPTION,
    metadata: {
      family: "web",
      source: "builtin",
      keywords: [
        "browser",
        "web",
        "navigate",
        "click",
        "form",
        "screenshot",
        "scrape",
        "chromium",
        "page",
      ],
      preferredProfiles: ["general", "operator"],
      hiddenByDefault: false,
      // The browser mutates external (web/network) state, not the filesystem.
      // No action writes an arg-directed host path (screenshots return
      // in-memory image items; there is no save-to-path or arbitrary-JS
      // action), so it performs no arg-directed FS writes. Audited to satisfy
      // the virtualNoFsWrites contract in tools/types.ts.
      mutating: true,
      virtualNoFsWrites: true,
      deferred: true,
    },
    recoveryCategory: "side-effecting",
    timeoutMs: 180_000,
    timeoutBehavior: "tool",
    maxResultBytes: 12_000_000,
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [...BROWSER_ACTIONS],
          description: "The browser action to perform.",
        },
        url: { type: "string", description: "Target URL (navigate, new_tab)." },
        ref: {
          type: "string",
          description:
            "Element ref from the latest snapshot, e.g. e3 (click, type).",
        },
        text: { type: "string", description: "Text to type (type)." },
        submit: {
          type: "boolean",
          description: "Press Enter after typing (type).",
        },
        key: {
          type: "string",
          description: "Named key to press (press_key), e.g. Enter, Tab.",
        },
        direction: {
          type: "string",
          enum: ["up", "down"],
          description: "Scroll direction (scroll).",
        },
        format: {
          type: "string",
          enum: ["png", "jpeg"],
          description: "Screenshot format (screenshot).",
        },
        full_page: {
          type: "boolean",
          description: "Capture the full page, not just the viewport.",
        },
        tab_id: {
          type: "number",
          description: "Target tab id (defaults to the active tab).",
        },
        max_chars: {
          type: "number",
          description: "Max characters to return (get_text).",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
    checkPermissions(
      input: unknown,
      context: ToolEvaluatorContext,
    ): PermissionResult {
      const action = str((input as { action?: unknown }).action);
      if (action !== undefined && BROWSER_READ_ONLY_ACTIONS.has(action)) {
        return {
          behavior: "allow",
          decisionReason: { type: "other", reason: "read-only browser action" },
        };
      }
      if (action === "navigate") {
        const permissionContext = context.getAppState().toolPermissionContext;
        const ruleContent = navigateRuleContent(input);
        const denyRule = getRuleByContentsForTool(
          permissionContext,
          BROWSER_TOOL_NAME,
          "deny",
        ).get(ruleContent);
        if (denyRule !== undefined) {
          return {
            behavior: "deny",
            message: `Browsing to ${ruleContent} is denied by a rule.`,
            decisionReason: { type: "rule", rule: denyRule },
          };
        }
        const allowRule = getRuleByContentsForTool(
          permissionContext,
          BROWSER_TOOL_NAME,
          "allow",
        ).get(ruleContent);
        if (allowRule !== undefined) {
          return {
            behavior: "allow",
            decisionReason: { type: "rule", rule: allowRule },
          };
        }
        return {
          behavior: "ask",
          message: `AgenC wants to ${describeAction(input as BrowserToolInput)} in the browser.`,
          updatedInput: input as Record<string, unknown>,
          suggestions: navigateSuggestions(ruleContent),
          decisionReason: {
            type: "other",
            reason: "browser navigation requires approval",
          },
        };
      }
      return {
        behavior: "ask",
        message: `AgenC wants to ${describeAction(input as BrowserToolInput)}.`,
        updatedInput: input as Record<string, unknown>,
        decisionReason: {
          type: "other",
          reason: "browser action requires approval",
        },
      };
    },
    async execute(rawArgs: Record<string, unknown>): Promise<ToolResult> {
      const input = rawArgs as BrowserToolInput;
      const signal = input.__abortSignal;
      try {
        return await dispatch(input, signal);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(`Browser action failed: ${message}`);
      }
    },
  };
}

function tabIdOf(input: BrowserToolInput): number | undefined {
  return typeof input.tab_id === "number" && Number.isInteger(input.tab_id)
    ? input.tab_id
    : undefined;
}

function clampMax(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return GET_TEXT_DEFAULT_MAX;
  }
  return Math.min(GET_TEXT_HARD_MAX, Math.floor(value));
}
