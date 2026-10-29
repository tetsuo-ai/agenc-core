import { homedir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import React from "react";
import stripAnsi from "strip-ansi";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FullscreenLayout, statusLineUsageItems } from "./FullscreenLayout.js";
import { ThemeProvider } from "./design-system/ThemeProvider.js";
import { FullscreenModeProvider } from "../context/fullscreenModeContext.js";
import { SessionUsageContext, type SessionUsageSnapshot } from "../context/sessionUsageContext.js";
import {
  StatusContextUsageContext,
  StatusEffortContext,
  StatusOffPeakContext,
  StatusPromptCacheContext,
  StatusZdrContext,
} from "../context/statusEffortContext.js";
import type { ZeroDataRetentionStatus } from "../../llm/zero-data-retention.js";
import { AppStateProvider, getDefaultAppState } from "../state/AppState.js";
import { Text } from "../ink.js";
import { createRoot } from "../ink/root.js";
import { stringWidth } from "../ink/stringWidth.js";
import { renderToAnsiString, renderToString } from "../../utils/staticRender.js";
import { getTheme } from "../../utils/theme.js";
import { resolveThemeSetting } from "../../utils/terminalBackground.js";
import { TUI_THEME_SETTINGS } from "../../config/schema.js";
import { modelDisplayString } from "../../utils/model/model.js";
import { offPeakScheduleFor, type OffPeakSchedule } from "../../session/off-peak-pricing.js";
import { promptCacheSharePercent } from "../../session/prompt-cache-share.js";
import { createSessionTranscriptStateForTesting } from "../session-transcript.js";

const MODEL = "qwen3-coder-480b-a35b-instruct";
const SPEND: SessionUsageSnapshot = { costUsd: 0.0044, hasUnknownCost: false };
const DEEPSEEK_HOURS = offPeakScheduleFor("deepseek", "deepseek-flash");
const SATURDAY_OFF_PEAK = "2026-10-24T02:00:00Z";
const MONDAY_PEAK = "2026-10-19T02:00:00Z";

type FooterOptions = {
  readonly columns?: number;
  readonly rows?: number;
  readonly contextPercent?: number | null;
  readonly cachePercent?: number | null;
  readonly usage?: SessionUsageSnapshot | null;
  readonly offPeak?: OffPeakSchedule | null;
  readonly effort?: string | null;
  readonly zdr?: ZeroDataRetentionStatus | null;
};

function footerTree(options: FooterOptions): React.ReactElement {
  return (
    <AppStateProvider initialState={{ ...getDefaultAppState(), mainLoopModel: MODEL }}>
      <SessionUsageContext value={options.usage === undefined ? SPEND : options.usage}>
        <StatusEffortContext value={options.effort ?? null}>
          <StatusContextUsageContext value={options.contextPercent === undefined ? 9 : options.contextPercent}>
            <StatusPromptCacheContext value={options.cachePercent === undefined ? 91 : options.cachePercent}>
              <StatusOffPeakContext value={options.offPeak ?? null}>
                <StatusZdrContext value={options.zdr ?? null}>
                  <FullscreenModeProvider enabled>
                    <FullscreenLayout scrollable={<Text>ready</Text>} bottom={<Text>prompt</Text>} />
                  </FullscreenModeProvider>
                </StatusZdrContext>
              </StatusOffPeakContext>
            </StatusPromptCacheContext>
          </StatusContextUsageContext>
        </StatusEffortContext>
      </SessionUsageContext>
    </AppStateProvider>
  );
}

/** The rendered status line: its one or two rows under the prompt, joined. */
async function footer(options: FooterOptions = {}): Promise<string> {
  const output = await renderToString(footerTree(options), { columns: options.columns ?? 140, rows: options.rows ?? 24 });
  const rows = output.split(/\r?\n/u);
  const prompt = rows.findIndex((row) => row.includes("prompt"));
  const status = rows.slice(prompt + 1).filter((row) => row.trim().length > 0);
  expect(status.length, output).toBeGreaterThan(0);
  expect(status.length, output).toBeLessThanOrEqual(2);
  return status.join("\n");
}

const ANSI16 = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];

/** Each visible character of the status line with the foreground it is drawn in. */
async function coloredFooter(
  setting: (typeof TUI_THEME_SETTINGS)[number],
  options: FooterOptions = {},
): Promise<{ readonly text: string; readonly colorOf: (part: string, from?: number) => string | null }> {
  const output = await renderToAnsiString(
    <ThemeProvider initialState={setting}>{footerTree(options)}</ThemeProvider>,
    { columns: options.columns ?? 140, rows: 24, color: true },
  );
  // The status line's last row: the usage block and the ZDR badge.
  const row = output.split(/\r?\n/u).findLast((line) => stripAnsi(line).trim().length > 0);
  expect(row, output).toBeDefined();
  const cells: { ch: string; fg: string | null }[] = [];
  let fg: string | null = null;
  // Drop OSC sequences (hyperlinks), then walk SGR codes and characters.
  const line = row!.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/gu, "");
  for (const token of line.match(/\u001b\[[0-9;]*[A-Za-z]|[^\u001b]/gu) ?? []) {
    if (!token.startsWith("\u001b")) {
      cells.push({ ch: token, fg });
      continue;
    }
    if (!token.endsWith("m")) continue;
    const params = token.slice(2, -1).split(";").map((value) => Number(value || "0"));
    for (let i = 0; i < params.length; i += 1) {
      const code = params[i]!;
      if (code === 0 || code === 39) fg = null;
      else if (code >= 30 && code <= 37) fg = `ansi:${ANSI16[code - 30]}`;
      else if (code >= 90 && code <= 97) fg = `ansi:${ANSI16[code - 90]}Bright`;
      else if (code === 38 && params[i + 1] === 2) {
        fg = `rgb(${params[i + 2]},${params[i + 3]},${params[i + 4]})`;
        i += 4;
      } else if (code === 38 && params[i + 1] === 5) {
        fg = `ansi256(${params[i + 2]})`;
        i += 2;
      } else if (code === 48) i += params[i + 1] === 2 ? 4 : 2;
    }
  }
  const text = cells.map((cell) => cell.ch).join("");
  /** The one color every visible character of `part` is drawn in. */
  const colorOf = (part: string, from = 0): string | null => {
    const index = text.indexOf(part, from);
    expect(index, `${part} in ${text}`).toBeGreaterThanOrEqual(0);
    const colors = new Set(cells.slice(index, index + part.length).filter((cell) => cell.ch.trim() !== "").map((cell) => cell.fg));
    expect(colors.size, `${part} has one color`).toBe(1);
    return [...colors][0]!;
  };
  return { text, colorOf };
}

/** Cache share from token_count events, as App computes it for the footer. */
function cacheShareOf(...payloads: readonly Record<string, unknown>[]): number | null {
  const state = createSessionTranscriptStateForTesting(payloads.map((payload, index) => ({
    type: "token_count", id: `token-${index}`, seq: index + 1,
    payload: { model: "model", completionTokens: 10, ...payload },
  })));
  return promptCacheSharePercent(state.promptCache);
}

beforeEach(() => {
  vi.spyOn(process, "cwd").mockReturnValue(join(homedir(), "project"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("status line cache share", () => {
  test("sits between ctx and cost with the same separators", async () => {
    expect(await footer()).toContain("ctx 9% · cache 91% · $0.0044");
  });

  test("shows the share a reporting provider's calls add up to, rounded", async () => {
    const share = cacheShareOf(
      { provider: "deepseek", promptTokens: 1000, totalTokens: 1010, cachedInputTokens: 0 },
      { provider: "deepseek", promptTokens: 1000, totalTokens: 1010, cachedInputTokens: 1000 },
      { provider: "deepseek", promptTokens: 1000, totalTokens: 1010, cachedInputTokens: 1000 },
    );
    expect(share).toBe(67);
    expect(await footer({ cachePercent: share })).toContain("ctx 9% · cache 67% · $0.0044");
  });

  test("is hidden for providers that report no cached tokens and for local models", async () => {
    const neverReported = cacheShareOf({ provider: "groq", promptTokens: 4000, totalTokens: 4010 });
    const local = cacheShareOf({ provider: "ollama", promptTokens: 4000, totalTokens: 4010, cachedInputTokens: 3000 });
    const beforeUsage = cacheShareOf();
    for (const share of [neverReported, local, beforeUsage]) {
      expect(share).toBeNull();
      const line = await footer({ cachePercent: share });
      expect(line).not.toContain("cache");
      expect(line).toContain("ctx 9% · $0.0044");
    }
  });

  test("joins the cost alone when no context figure is known yet", async () => {
    expect(await footer({ contextPercent: null })).toContain("cache 91% · $0.0044");
  });

  test("narrow terminals shorten facts one step at a time and never drop the cache share", async () => {
    const model = modelDisplayString(MODEL);
    const left = ["~/project", model, "high effort", "asks first"].join(" · ");
    const right = "ctx 9% · cache 91% · $0.0044";
    // The row is padded by two columns on each side, with a two-column gap before the right block.
    const fits = 4 + stringWidth(left) + 2 + stringWidth(right);

    const full = await footer({ columns: fits, effort: "high effort" });
    expect(full).toContain(left);
    expect(full).toContain(right);
    expect(full.split("\n")).toHaveLength(1);

    // One column short: the effort takes its short form first, nothing goes.
    const effort = await footer({ columns: fits - 1, effort: "high effort" });
    expect(effort).toContain(["~/project", model, "high", "asks first"].join(" · "));
    expect(effort).toContain(right);

    // Then the mode, then the cache share's name.
    const mode = await footer({ columns: fits - " effort".length - 1, effort: "high effort" });
    expect(mode).toContain(["~/project", model, "high", "asks"].join(" · "));
    expect(mode).toContain(right);
    const cache = await footer({ columns: fits - " effort".length - " first".length - 1, effort: "high effort" });
    expect(cache).toContain("ctx 9% · c 91% · $0.0044");
    expect(cache.split("\n")).toHaveLength(1);

    // Narrower than one row can hold: the usage block moves to a second row.
    const wrapped = (await footer({ columns: 50, effort: "high effort" })).split("\n");
    expect(wrapped).toHaveLength(2);
    expect(wrapped[0]).toMatch(/high( effort)? · asks/u);
    expect(wrapped[1]).toMatch(/ctx 9% · c(ache)? 91% · \$0\.0044\s*$/u);
  });
});

describe("status line off-peak mark", () => {
  test("follows the cost inside the provider's off-peak hours", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(SATURDAY_OFF_PEAK) });
    expect(await footer({ offPeak: DEEPSEEK_HOURS })).toContain("ctx 9% · cache 91% · $0.0044 off-peak");
  });

  test("is hidden at a peak hour", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(MONDAY_PEAK) });
    const line = await footer({ offPeak: DEEPSEEK_HOURS });
    expect(line).toContain("ctx 9% · cache 91% · $0.0044");
    expect(line).not.toContain("off-peak");
  });

  test("shows for Ollama Cloud's DeepSeek models outside Ollama's peak hours", async () => {
    const ollama = offPeakScheduleFor("ollama-cloud", "deepseek-v4.1-flash:1017");
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(SATURDAY_OFF_PEAK) });
    expect(await footer({ offPeak: ollama })).toContain("ctx 9% · cache 91% · $0.0044 off-peak");
    vi.setSystemTime(new Date("2026-10-22T13:00:00Z")); // A Thursday, inside Ollama's peak hours.
    expect(await footer({ offPeak: ollama })).not.toContain("off-peak");
  });

  test("is hidden for providers without recorded hours", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(SATURDAY_OFF_PEAK) });
    for (const schedule of [
      offPeakScheduleFor("ollama-cloud", "glm-5.3"),
      offPeakScheduleFor("openrouter", "deepseek/deepseek-v4.1-flash"),
      offPeakScheduleFor("anthropic", "claude-opus-5-5"),
    ]) {
      expect(schedule).toBeNull();
      expect(await footer({ offPeak: schedule })).not.toContain("off-peak");
    }
  });

  test("never qualifies a missing or unknown price", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(SATURDAY_OFF_PEAK) });
    expect(await footer({ offPeak: DEEPSEEK_HOURS, usage: null })).not.toContain("off-peak");
    const unknown = await footer({
      offPeak: DEEPSEEK_HOURS,
      usage: { costUsd: 0.045, hasUnknownCost: false, costEstimated: true },
    });
    expect(unknown).toContain("price unknown");
    expect(unknown).not.toContain("off-peak");
  });

  test("updates when an hour boundary passes while nothing else renders", async () => {
    // One second before peak hours start on a Monday.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-19T00:59:59.900Z") });
    const stdout = new PassThrough();
    Object.assign(stdout, { columns: 140, rows: 24 });
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true, ref() {}, unref() {}, setRawMode() {},
    });
    let output = "";
    stdout.on("data", chunk => { output += chunk.toString(); });
    const latestFrame = () => {
      const end = output.lastIndexOf("\x1b[?2026l");
      const start = output.lastIndexOf("\x1b[?2026h", end);
      return stripAnsi(output.slice(start, end));
    };
    const root = await createRoot({
      patchConsole: false,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
    });
    try {
      root.render(
        <AppStateProvider initialState={{ ...getDefaultAppState(), mainLoopModel: MODEL }}>
          <SessionUsageContext value={SPEND}>
            <StatusOffPeakContext value={DEEPSEEK_HOURS}>
              <FullscreenModeProvider enabled>
                <FullscreenLayout scrollable={<Text>ready</Text>} bottom={<Text>prompt</Text>} />
              </FullscreenModeProvider>
            </StatusOffPeakContext>
          </SessionUsageContext>
        </AppStateProvider>,
      );
      await vi.waitFor(() => expect(latestFrame()).toContain("$0.0044 off-peak"));
      // The clock passes 01:00 UTC; the footer re-checks just after the hour.
      vi.setSystemTime(new Date("2026-10-19T01:00:01Z"));
      await vi.waitFor(() => {
        expect(latestFrame()).toContain("$0.0044");
        expect(latestFrame()).not.toContain("off-peak");
      }, { timeout: 3_000 });
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  test("shortens to op on a narrow terminal before the model name is cut", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(SATURDAY_OFF_PEAK) });
    const model = modelDisplayString(MODEL);
    const left = ["~/project", model, "asks first"].join(" · ");
    const fits = 4 + stringWidth(left) + 2 + stringWidth("ctx 9% · $0.0044 off-peak");
    const full = await footer({ columns: fits, cachePercent: null, offPeak: DEEPSEEK_HOURS });
    expect(full).toContain(left);
    expect(full).toContain("ctx 9% · $0.0044 off-peak");
    // The mode shortens first, then the note, while the model keeps its name.
    const narrower = await footer({ columns: fits - " first".length - 1, cachePercent: null, offPeak: DEEPSEEK_HOURS });
    expect(narrower).toContain(["~/project", model, "asks"].join(" · "));
    expect(narrower).toContain("ctx 9% · $0.0044 op");
    expect(narrower.split("\n")).toHaveLength(1);
  });

  test("labels compose in the documented order", () => {
    expect(statusLineUsageItems(9, 91, "$0.0044", true)).toEqual([
      { key: "ctx", spans: [{ text: "ctx ", color: "text2" }, { text: "9%", color: "accentSoft" }] },
      { key: "cache", spans: [{ text: "cache ", color: "text2" }, { text: "91%", color: "accentSoft" }] },
      { key: "spend", spans: [{ text: "$0.0044", color: "accentSoft" }, { text: " off-peak", color: "text2" }] },
    ]);
    expect(statusLineUsageItems(null, null, "≥$0.500", true, "accent")).toEqual([
      { key: "spend", spans: [{ text: "≥$0.500", color: "accent" }, { text: " off-peak", color: "text2" }] },
    ]);
    expect(statusLineUsageItems(85, null, "price unknown", true)).toEqual([
      { key: "ctx", spans: [{ text: "ctx ", color: "text2" }, { text: "85%", color: "error" }] },
      { key: "spend", spans: [{ text: "price unknown", color: "text" }] },
    ]);
    expect(statusLineUsageItems(9, null, null, true)).toEqual([
      { key: "ctx", spans: [{ text: "ctx ", color: "text2" }, { text: "9%", color: "accentSoft" }] },
    ]);
  });
});

describe("status line usage colors", () => {
  test("covers every theme setting", () => {
    expect(TUI_THEME_SETTINGS).toEqual([
      "auto", "dark", "light", "light-daltonized", "dark-daltonized", "light-ansi", "dark-ansi", "olive",
    ]);
  });

  test.each(TUI_THEME_SETTINGS)("%s: figures in the value color, names and separators in secondary ink", async (setting) => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(SATURDAY_OFF_PEAK) });
    const theme = getTheme(resolveThemeSetting(setting));
    // The dark ANSI theme's soft accent is a dark magenta; its bright accent reads on black.
    const value = setting === "dark-ansi" ? theme.accent : theme.accentSoft;
    const { text, colorOf } = await coloredFooter(setting, { offPeak: DEEPSEEK_HOURS });
    const right = text.indexOf("ctx 9%");
    expect(text.slice(right)).toBe("ctx 9% · cache 91% · $0.0044 off-peak");
    expect(colorOf("ctx", right)).toBe(theme.text2);
    expect(colorOf("9%", right)).toBe(value);
    expect(colorOf("cache", right)).toBe(theme.text2);
    expect(colorOf("91%", right)).toBe(value);
    expect(colorOf("$0.0044", right)).toBe(value);
    expect(colorOf("off-peak", right)).toBe(theme.text2);
    const firstSeparator = text.indexOf("·", right);
    expect(colorOf("·", firstSeparator)).toBe(theme.text2);
    expect(colorOf("·", firstSeparator + 1)).toBe(theme.text2);
    // The left side keeps its colors.
    expect(colorOf("~/project")).toBe(theme.text2);
    expect(colorOf(modelDisplayString(MODEL))).toBe(theme.text);
    expect(colorOf("asks first")).toBe(theme.text);
  });

  test.each(TUI_THEME_SETTINGS)("%s: a full context stays an error and an unknown price keeps primary ink", async (setting) => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(SATURDAY_OFF_PEAK) });
    const theme = getTheme(resolveThemeSetting(setting));
    const { text, colorOf } = await coloredFooter(setting, {
      contextPercent: 85,
      cachePercent: null,
      offPeak: DEEPSEEK_HOURS,
      usage: { costUsd: 0.045, hasUnknownCost: false, costEstimated: true },
    });
    const right = text.indexOf("ctx 85%");
    expect(text.slice(right)).toBe("ctx 85% · price unknown");
    expect(colorOf("ctx", right)).toBe(theme.text2);
    expect(colorOf("85%", right)).toBe(theme.error);
    expect(colorOf("price unknown", right)).toBe(theme.text);
  });
});

const ZDR: Record<ZeroDataRetentionStatus["state"], ZeroDataRetentionStatus> = {
  zdr: { provider: "cerebras", state: "zdr", reason: "Cerebras does not retain inference inputs and outputs." },
  retained: { provider: "grok", state: "retained", reason: "xAI keeps every API request and response for 30 days." },
  unknown: { provider: "openai-compatible", state: "unknown", reason: "Requests go to example.com." },
};

describe("status line ZDR badge", () => {
  test.each([160, 120, 100, 80, 60, 50, 40])("is on screen with every other fact at %i columns", async (columns) => {
    const output = await renderToString(footerTree({ columns, effort: "high effort", zdr: ZDR.retained }), { columns, rows: 24 });
    const rows = output.split(/\r?\n/u);
    const prompt = rows.findIndex((row) => row.includes("prompt"));
    const status = rows.slice(prompt + 1).filter((row) => row.trim().length > 0);
    // The prompt stays above the status line, which is one row or two.
    expect(prompt, output).toBeGreaterThan(0);
    expect(status.length, output).toBeGreaterThanOrEqual(1);
    expect(status.length, output).toBeLessThanOrEqual(2);
    expect(rows.length, output).toBeLessThanOrEqual(24);
    const footerText = status.join("\n");
    for (const fact of ["project", "high", "ask", "ctx 9%", "91%", "$0.0044", "ZDR"]) {
      expect(footerText, `${columns}: ${fact}`).toContain(fact);
    }
    expect(footerText).toMatch(/qwen3/u);
    for (const row of rows) expect(stringWidth(row), `${columns}: ${row}`).toBeLessThanOrEqual(columns);
    expect(status.at(-1)!.trimEnd().endsWith("ZDR"), output).toBe(true);
    expect(status.length).toBe(columns >= 80 ? 1 : 2);
  });

  test.each(["olive", "dark", "light"] as const)("%s: green when nothing is kept, red when it may be, dim when unknown", async (setting) => {
    const theme = getTheme(resolveThemeSetting(setting));
    const green = await coloredFooter(setting, { zdr: ZDR.zdr });
    expect(green.text.trimEnd().endsWith("ZDR")).toBe(true);
    expect(green.colorOf("ZDR", green.text.lastIndexOf("ZDR"))).toBe(theme.success);
    const red = await coloredFooter(setting, { zdr: ZDR.retained });
    expect(red.colorOf("ZDR", red.text.lastIndexOf("ZDR"))).toBe(theme.error);
    const unknown = await coloredFooter(setting, { zdr: ZDR.unknown });
    expect(unknown.text.trimEnd().endsWith("ZDR?")).toBe(true);
    expect(unknown.colorOf("ZDR?", unknown.text.lastIndexOf("ZDR?"))).toBe(theme.inactive);
    // The usage block keeps its colors next to the badge.
    expect(red.colorOf("9%", red.text.indexOf("ctx 9%"))).toBe(theme.accentSoft);
  });

  test("keeps the badge and the usage colors when the line wraps to two rows", async () => {
    const theme = getTheme(resolveThemeSetting("olive"));
    const { text, colorOf } = await coloredFooter("olive", { columns: 50, effort: "high effort", zdr: ZDR.zdr });
    expect(text.trimStart()).toMatch(/^ctx 9% · c(ache)? 91% · \$0\.0044 · ZDR\s*$/u);
    expect(colorOf("ZDR", text.lastIndexOf("ZDR"))).toBe(theme.success);
    expect(colorOf("91%", text.indexOf("91%"))).toBe(theme.accentSoft);
    expect(colorOf("ctx", text.indexOf("ctx"))).toBe(theme.text2);
  });

  test("is absent until the session's provider is known", async () => {
    expect(await footer({ zdr: null })).not.toContain("ZDR");
  });
});
