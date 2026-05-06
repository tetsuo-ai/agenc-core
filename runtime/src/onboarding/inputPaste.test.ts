import { mkdtemp, readFile, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  MAX_ONBOARDING_INPUT_LENGTH,
  maybeTruncateInput,
} from "./inputPaste.js";
import {
  cleanupOldPastes,
  hashPastedText,
  retrievePastedText,
  storePastedText,
} from "./pasteStore.js";

describe("onboarding input paste helpers", () => {
  test("leaves short input unchanged", () => {
    expect(maybeTruncateInput("short key")).toEqual({
      input: "short key",
      pastedContents: [],
    });
  });

  test("captures the middle of very long pasted input", () => {
    const longInput = "a".repeat(MAX_ONBOARDING_INPUT_LENGTH + 10);
    const result = maybeTruncateInput(longInput);

    expect(result.input).toContain("[Pasted content #1:");
    expect(result.pastedContents).toHaveLength(1);
    expect(result.pastedContents[0]?.content.length).toBe(
      longInput.length - 2_000,
    );
  });
});

describe("onboarding paste store", () => {
  test("stores and retrieves paste content with private file mode", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-paste-store-"));
    try {
      const hash = hashPastedText("secret pasted key");
      const path = await storePastedText({
        agencHome,
        hash,
        content: "secret pasted key",
      });

      expect(await readFile(path, "utf8")).toBe("secret pasted key");
      expect(await retrievePastedText({ agencHome, hash })).toBe(
        "secret pasted key",
      );
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  test("cleans up old paste files without touching recent ones", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-paste-store-"));
    try {
      const oldHash = hashPastedText("old pasted key");
      const recentHash = hashPastedText("recent pasted key");
      const oldPath = await storePastedText({
        agencHome,
        hash: oldHash,
        content: "old pasted key",
      });
      await storePastedText({
        agencHome,
        hash: recentHash,
        content: "recent pasted key",
      });
      const oldDate = new Date("2026-01-01T00:00:00.000Z");
      await utimes(oldPath, oldDate, oldDate);

      await expect(
        cleanupOldPastes({
          agencHome,
          now: new Date("2026-01-10T00:00:00.000Z"),
          maxAgeMs: 24 * 60 * 60 * 1000,
        }),
      ).resolves.toBe(1);
      await expect(retrievePastedText({ agencHome, hash: oldHash })).resolves.toBeNull();
      await expect(retrievePastedText({ agencHome, hash: recentHash })).resolves.toBe(
        "recent pasted key",
      );
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });
});
