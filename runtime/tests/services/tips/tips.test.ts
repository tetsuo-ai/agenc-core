import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  getSessionsSinceLastShown,
  readTipHistory,
  recordTipShown,
} from "./tipHistory.js";
import {
  getBuiltInTips,
  getRelevantTips,
} from "./tipRegistry.js";
import {
  getTipToShowOnSpinner,
  recordShownTip,
  selectTipWithLongestTimeSinceShown,
} from "./tipScheduler.js";
import type { Tip, TipHistoryOptions } from "./types.js";

let tempRoot: string;
let historyFile: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "agenc-tips-"));
  historyFile = join(tempRoot, "tips", "history.json");
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

function history(sessionCount: number): TipHistoryOptions {
  return { historyFile, sessionCount };
}

function testTip(id: string, cooldownSessions = 0): Tip {
  return {
    id,
    cooldownSessions,
    content: async () => id,
    isRelevant: async () => true,
  };
}

describe("tip history", () => {
  it("persists the startup session when a tip is shown", async () => {
    recordTipShown("theme-command", history(7));

    expect(getSessionsSinceLastShown("theme-command", history(10))).toBe(3);
    await expect(readFile(historyFile, "utf8")).resolves.toContain(
      '"theme-command": 7',
    );
  });

  it("returns Infinity for tips that have never been shown", () => {
    expect(getSessionsSinceLastShown("new-user-warmup", history(3))).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it("falls back to default state for missing and corrupt history files", async () => {
    expect(readTipHistory(history(4))).toEqual({
      numStartups: 4,
      tipsHistory: {},
    });

    await mkdir(dirname(historyFile), { recursive: true });
    await writeFile(historyFile, "{not json", "utf8");
    expect(readTipHistory(history(5))).toEqual({
      numStartups: 5,
      tipsHistory: {},
    });
  });

  it("does not rewrite duplicate records in the same session", async () => {
    recordTipShown("theme-command", history(12));
    const before = await readFile(historyFile, "utf8");

    recordTipShown("theme-command", history(12));

    await expect(readFile(historyFile, "utf8")).resolves.toBe(before);
  });

  it("writes private history directory and file permissions", async () => {
    recordTipShown("theme-command", history(12));

    expect((await stat(dirname(historyFile))).mode & 0o777).toBe(0o700);
    expect((await stat(historyFile)).mode & 0o777).toBe(0o600);
  });
});

describe("tip registry", () => {
  it("keeps built-in tips AgenC-branded", async () => {
    const forbidden = [
      new RegExp(["Open", "Clau", "de"].join("")),
      new RegExp(["clau", "de"].join(""), "i"),
      new RegExp(["\\.clau", "de"].join(""), "i"),
    ];
    expect(getBuiltInTips().length).toBeGreaterThan(40);
    for (const tip of getBuiltInTips()) {
      const content = await tip.content();
      for (const pattern of forbidden) {
        expect(content).not.toMatch(pattern);
      }
    }
  });

  it("supports custom-tip override settings", async () => {
    const tips = await getRelevantTips({
      settings: {
        spinnerTipsOverride: {
          tips: ["Custom one", "Custom two"],
          excludeDefault: true,
        },
      },
      history: history(1),
    });

    expect(tips.map((tip) => tip.id)).toEqual(["custom-tip-0", "custom-tip-1"]);
    await expect(tips[0]?.content()).resolves.toBe("Custom one");
  });

  it("appends custom tips to default tips when defaults are not excluded", async () => {
    const tips = await getRelevantTips({
      settings: {
        spinnerTipsOverride: {
          tips: ["Custom one"],
          excludeDefault: false,
        },
      },
      history: history(100),
    });

    expect(tips.map((tip) => tip.id)).toContain("theme-command");
    expect(tips.map((tip) => tip.id)).toContain("custom-tip-0");
  });

  it("filters built-in tips by cooldown history", async () => {
    recordTipShown("theme-command", history(10));

    const tooSoon = await getRelevantTips({ history: history(20) });
    expect(tooSoon.map((tip) => tip.id)).not.toContain("theme-command");

    const afterCooldown = await getRelevantTips({ history: history(31) });
    expect(afterCooldown.map((tip) => tip.id)).toContain("theme-command");
  });

  it("keeps optional surface tips disabled unless the caller enables them", async () => {
    const disabled = await getRelevantTips({ history: history(100) });
    expect(disabled.map((tip) => tip.id)).not.toContain("mobile-app");
    expect(disabled.map((tip) => tip.id)).not.toContain("frontend-design-plugin");

    const enabled = await getRelevantTips({
      bashTools: new Set(["vercel"]),
      features: { marketplace: true, mobile: true },
      history: history(100),
      readFileState: new Map([["/repo/index.html", {}]]),
    });
    expect(enabled.map((tip) => tip.id)).toContain("mobile-app");
    expect(enabled.map((tip) => tip.id)).toContain("frontend-design-plugin");
    expect(enabled.map((tip) => tip.id)).toContain("vercel-plugin");
  });
});

describe("tip scheduler", () => {
  it("selects the relevant tip with the longest time since shown", () => {
    recordTipShown("recent", history(9));
    recordTipShown("stale", history(2));

    expect(
      selectTipWithLongestTimeSinceShown(
        [testTip("recent"), testTip("stale")],
        history(10),
      )?.id,
    ).toBe("stale");
  });

  it("honors disabled spinner-tip settings", async () => {
    await expect(
      getTipToShowOnSpinner({
        settings: { spinnerTipsEnabled: false },
        history: history(100),
      }),
    ).resolves.toBeUndefined();
  });

  it("selects the longest-unseen relevant tip through the registry path", async () => {
    recordTipShown("custom-tip-0", history(9));
    recordTipShown("custom-tip-1", history(2));

    const tip = await getTipToShowOnSpinner({
      settings: {
        spinnerTipsOverride: {
          tips: ["Recent custom", "Stale custom"],
          excludeDefault: true,
        },
      },
      history: history(10),
    });

    expect(tip?.id).toBe("custom-tip-1");
    await expect(tip?.content()).resolves.toBe("Stale custom");
  });

  it("records shown tips and emits analytics metadata", () => {
    const tip = testTip("theme-command", 20);
    const logEvent = vi.fn();

    recordShownTip(tip, {
      history: history(12),
      analytics: { logEvent },
    });

    expect(getSessionsSinceLastShown("theme-command", history(15))).toBe(3);
    expect(logEvent).toHaveBeenCalledWith("agenc_tip_shown", {
      tipId: "theme-command",
      tipIdLength: "theme-command".length,
      cooldownSessions: 20,
    });
  });
});
