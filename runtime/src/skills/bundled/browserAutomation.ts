/**
 * Bundled `browser-automation` skill (task 18): teaches the snapshot → act →
 * re-snapshot loop for the `Browser` tool. Pure data — registered from
 * `bundledSkills.ts` so there is no circular import back into this module.
 *
 * @module
 */

import type { ContentBlockParam } from "@anthropic-ai/sdk/resources/index.mjs";
import type { BundledSkillDefinition } from "../bundledSkills.js";

const BROWSER_AUTOMATION_GUIDE = `# Browser automation

Drive the web with the \`Browser\` tool. It runs an isolated Chromium instance
with a dedicated profile; every request is forced through a policy proxy that
blocks private, loopback, and cloud-metadata addresses by default.

## The loop: snapshot → act → re-snapshot

1. **navigate** to the page. The result is an accessibility snapshot — an
   indented outline of the page where interactive elements are tagged
   \`[ref=eN]\`.
2. **Act by ref, never by guess.** \`click {ref}\`, \`type {ref, text}\`. Refs
   come only from the latest snapshot. Do not invent refs or use CSS selectors.
3. Acting returns a **fresh snapshot** so you can see what changed and choose
   the next ref. Re-**snapshot** any time you are unsure the refs are current.

## Filling a form

- \`type {ref, text}\` focuses the field and types.
- Add \`submit: true\` to press Enter after (submits most forms), or \`click\`
  the submit button's ref, or \`press_key {key: "Enter"}\`.
- After submitting, read the resulting snapshot (or \`get_text\`) to confirm.

## Reading a page

- \`get_text\` returns the visible text — good for extracting content.
- \`screenshot\` returns an image when layout matters.

## Multiple tabs

- \`new_tab {url}\` opens and navigates a tab; \`tabs\` lists ids; \`select_tab
  {tab_id}\` switches; \`close_tab {tab_id}\` closes.

## Rules of thumb

- Refs are valid only for the tab and page version they came from. **Always
  snapshot after navigation before using refs.**
- If a ref is rejected as unknown, the page changed — snapshot again.
- If navigation is blocked, the target resolved to a private/loopback/metadata
  address. That is the SSRF policy; only a local-dev target with
  \`[browser].allow_private_network\` enabled is reachable.
- Prefer the accessibility snapshot over screenshots for deciding what to do;
  use screenshots to verify visual state.`;

export const BROWSER_AUTOMATION_SKILL: BundledSkillDefinition = {
  name: "browser-automation",
  description:
    "How to drive the Browser tool: the snapshot → act → re-snapshot loop, form filling, tabs, and the SSRF policy.",
  whenToUse:
    "When using the Browser tool to navigate, fill forms, click, or scrape web pages.",
  getPromptForCommand: (): Promise<ContentBlockParam[]> =>
    Promise.resolve([{ type: "text", text: BROWSER_AUTOMATION_GUIDE }]),
};
