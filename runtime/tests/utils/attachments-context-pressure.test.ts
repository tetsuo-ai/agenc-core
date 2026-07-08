/**
 * Task 7: the model-facing context-pressure signal.
 *
 * The producer used to be triple-disabled (feature flag absent, a
 * hard-coded `if (!false) return []`, and a 1M-window gate) and its
 * copy told the model it had "unlimited context". These tests pin the
 * live behavior: above half the auto-compact threshold, every turn
 * carries an honest usage line so the model can self-pace.
 */
import { afterEach, describe, expect, it } from "vitest";

import { getCompactionReminderAttachment } from "./attachments.js";
import { feature } from "../build/feature.js";
import { formatContextPressureReminder } from "./messages.js";
import { getAutoCompactThreshold } from "../services/compact/autoCompact.js";
import type { Message } from "../types/message.js";

const WINDOW_ENV = "AGENC_AUTO_COMPACT_WINDOW";

function userMessage(chars: number): Message {
  return {
    type: "user",
    uuid: "00000000-0000-0000-0000-000000000001",
    timestamp: new Date(0).toISOString(),
    message: { role: "user", content: "x".repeat(chars) },
  } as unknown as Message;
}

afterEach(() => {
  delete process.env[WINDOW_ENV];
  delete process.env.AGENC_DISABLE_COMPACT;
});

describe("context-pressure attachment producer", () => {
  it("is enabled at the feature gate", () => {
    expect(feature("COMPACTION_REMINDERS")).toBe(true);
  });

  it("stays silent below half the auto-compact threshold", () => {
    process.env[WINDOW_ENV] = "100000";
    const out = getCompactionReminderAttachment(
      [userMessage(10_000)],
      "test-model",
    );
    expect(out).toEqual([]);
  });

  it("emits live usage numbers above the signal fraction", () => {
    process.env[WINDOW_ENV] = "100000";
    const threshold = getAutoCompactThreshold("test-model");
    // ~75% of the threshold in estimated tokens (~4 chars/token).
    const out = getCompactionReminderAttachment(
      [userMessage(Math.floor(threshold * 0.75) * 4)],
      "test-model",
    );
    expect(out).toHaveLength(1);
    const attachment = out[0] as {
      type: string;
      used: number;
      threshold: number;
      remaining: number;
      percentUsed: number;
    };
    expect(attachment.type).toBe("compaction_reminder");
    expect(attachment.threshold).toBe(threshold);
    expect(attachment.percentUsed).toBeGreaterThanOrEqual(55);
    expect(attachment.percentUsed).toBeLessThanOrEqual(100);
    expect(attachment.remaining).toBe(
      Math.max(0, threshold - attachment.used),
    );
  });

  it("stays silent when auto-compact is disabled", () => {
    process.env[WINDOW_ENV] = "100000";
    process.env.AGENC_DISABLE_COMPACT = "1";
    const out = getCompactionReminderAttachment(
      [userMessage(999_999)],
      "test-model",
    );
    expect(out).toEqual([]);
  });
});

describe("formatContextPressureReminder", () => {
  it("renders percent, token counts, and pacing guidance", () => {
    const text = formatContextPressureReminder({
      used: 60_000,
      threshold: 100_000,
      remaining: 40_000,
      percentUsed: 60,
    });
    expect(text).toContain("~60% of the auto-compact threshold used");
    expect(text).toContain("~60k of ~100k tokens");
    expect(text).toContain("~40k left");
    expect(text).toContain("persisting important state");
    expect(text).not.toContain("unlimited context");
  });

  it("escalates the guidance when compaction is imminent", () => {
    const text = formatContextPressureReminder({
      used: 95_000,
      threshold: 100_000,
      remaining: 5_000,
      percentUsed: 95,
    });
    expect(text).toContain("Compaction is imminent");
  });
});
