/**
 * Model-facing name and description for the `Browser` tool.
 *
 * @module
 */

export const BROWSER_TOOL_NAME = "Browser";

/** Actions that only observe and are auto-approved (no permission prompt). */
export const BROWSER_READ_ONLY_ACTIONS: ReadonlySet<string> = new Set([
  "snapshot",
  "screenshot",
  "get_text",
  "tabs",
]);

export const BROWSER_TOOL_DESCRIPTION = `Drive a real, isolated Chromium browser to act on the web: open pages, read them, fill forms, click, and screenshot. Use this for sites with no API, content behind a login/JS, or any task that needs a real browser.

The browser has NO independent network access — every request is forced through a local policy proxy that blocks private, loopback, and cloud-metadata addresses by default (SSRF-safe). It uses a dedicated profile, never your real one.

Workflow — snapshot, act, re-snapshot:
1. \`navigate\` to a URL. The result is an accessibility snapshot of the page.
2. Each interactive element in a snapshot is tagged \`[ref=eN]\`. Address elements by that ref — never by CSS selector or guesswork.
3. \`click\`/\`type\` using a ref from the LATEST snapshot. Acting returns a fresh snapshot so you can see the result and pick your next ref.
4. Re-\`snapshot\` any time the page changed and you need current refs.

Actions:
- navigate {url}          — open a URL in the active tab (opens a tab if none); returns a snapshot
- snapshot                — accessibility snapshot of the active tab with element refs
- click {ref}             — click the element with that ref
- type {ref, text, submit?} — focus the element and type text; submit:true presses Enter after
- press_key {key}         — press a named key (Enter, Tab, Escape, ArrowDown, …)
- scroll {direction}      — scroll the viewport "up" or "down"
- screenshot {format?, full_page?} — PNG/JPEG image of the page
- get_text {max_chars?}   — the page's visible text
- new_tab {url?}          — open a new tab (optionally navigate it)
- tabs                    — list open tabs with their ids
- select_tab {tab_id}     — make a tab active
- close_tab {tab_id}      — close a tab

Refs are only valid for the tab and page version they came from — always snapshot after a navigation before using refs. Navigation and actions ask for approval by default; snapshot/screenshot/get_text/tabs are read-only and run without a prompt.`;
