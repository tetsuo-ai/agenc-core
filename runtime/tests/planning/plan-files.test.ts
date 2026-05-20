/**
 * Tests for `isSessionPlanFile` — the AgenC-compatible carve-out used
 * by `tools/system/filesystem.ts:validatePath` and
 * `tools/system/coding-common.ts:resolveWorkspacePath` to allow writes
 * to the active session's plan-file family even when the path is
 * outside the workspace allowlist.
 *
 * Mirrors reference `isSessionPlanFile`
 * (`src/utils/permissions/filesystem.ts:254`):
 *
 *     const expectedPrefix = join(getPlansDirectory(), getPlanSlug())
 *     return path.startsWith(expectedPrefix) && path.endsWith('.md')
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  clearAllPlanSlugs,
  copyPlanForResume,
  formatPlanText,
  getPlan,
  getPlanFilePath,
  getPlansDirectory,
  isSessionPlanFile,
  recoverPlanFromMessages,
  setPlanSlug,
  writePlan,
  writePlanSync,
} from "./plan-files.js";

describe("isSessionPlanFile", () => {
  let agencHome: string;

  beforeEach(() => {
    agencHome = mkdtempSync(join(tmpdir(), "agenc-plan-allowlist-"));
    clearAllPlanSlugs();
  });

  afterEach(() => {
    try {
      rmSync(agencHome, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    clearAllPlanSlugs();
  });

  test("matches the active session's main plan file", () => {
    const sessionId = "session-A";
    setPlanSlug({ sessionId, agencHome }, "moss-cipher-deadbeef");
    const planPath = getPlanFilePath({ sessionId, agencHome });
    expect(isSessionPlanFile(planPath, { sessionId, agencHome })).toBe(true);
  });

  test("matches the per-agent variant `<slug>-agent-<agentId>.md`", () => {
    // AgenC allows both the main plan and per-agent plan files for
    // the same session — the prefix is `getPlansDirectory()/<slug>` and
    // the suffix is `.md`. The agent-id segment fits between the slug
    // and the `.md` suffix.
    const sessionId = "session-B";
    const slug = "ember-bridge-cafef00d";
    setPlanSlug({ sessionId, agencHome }, slug);
    const agentPlanPath = join(
      getPlansDirectory({ sessionId, agencHome }),
      `${slug}-agent-explorer-1.md`,
    );
    expect(isSessionPlanFile(agentPlanPath, { sessionId, agencHome })).toBe(
      true,
    );
  });

  test("rejects another session's plan file (slug mismatch)", () => {
    setPlanSlug({ sessionId: "session-A", agencHome }, "alpha-aaaa-1111");
    setPlanSlug({ sessionId: "session-B", agencHome }, "beta-bbbb-2222");
    const otherSessionPlan = getPlanFilePath({
      sessionId: "session-B",
      agencHome,
    });
    expect(
      isSessionPlanFile(otherSessionPlan, { sessionId: "session-A", agencHome }),
    ).toBe(false);
  });

  test("rejects the slug index file (not `.md`)", () => {
    const sessionId = "session-A";
    setPlanSlug({ sessionId, agencHome }, "amber-anchor-12345678");
    const slugsIndex = join(
      getPlansDirectory({ sessionId, agencHome }),
      ".slugs.json",
    );
    expect(isSessionPlanFile(slugsIndex, { sessionId, agencHome })).toBe(false);
  });

  test("rejects an outright unrelated path", () => {
    setPlanSlug({ sessionId: "session-A", agencHome }, "amber-anchor-12345678");
    expect(
      isSessionPlanFile("/etc/passwd", { sessionId: "session-A", agencHome }),
    ).toBe(false);
    expect(
      isSessionPlanFile("/tmp/agenc-test.txt", {
        sessionId: "session-A",
        agencHome,
      }),
    ).toBe(false);
  });

  test("returns false on empty / non-string inputs", () => {
    setPlanSlug({ sessionId: "session-A", agencHome }, "amber-anchor-12345678");
    expect(isSessionPlanFile("", { sessionId: "session-A", agencHome })).toBe(
      false,
    );
    // @ts-expect-error — defensive runtime check coverage
    expect(isSessionPlanFile(undefined, { sessionId: "session-A", agencHome }))
      .toBe(false);
  });

  test("uses env/home fallback paths and rejects empty sanitized slugs", () => {
    const envHome = join(agencHome, "env-home");
    const userHome = join(agencHome, "user-home");

    expect(getPlansDirectory({ env: { AGENC_HOME: envHome } })).toBe(
      join(envHome, "plans"),
    );
    expect(getPlansDirectory({ env: { HOME: userHome } })).toBe(
      join(userHome, ".agenc", "plans"),
    );
    expect(() => setPlanSlug({ sessionId: "empty", agencHome }, " - ")).toThrow(
      /plan slug must not be empty/,
    );
  });

  test("sanitizes agent ids in per-agent plan paths", () => {
    const sessionId = "session-agent-sanitize";
    setPlanSlug({ sessionId, agencHome }, "safe-plan");

    expect(getPlanFilePath({
      sessionId,
      agencHome,
      agentId: "reviewer/../../evil",
    })).toBe(join(
      getPlansDirectory({ sessionId, agencHome }),
      "safe-plan-agent-reviewer-..-..-evil.md",
    ));
    expect(getPlanFilePath({
      sessionId,
      agencHome,
      agentId: "!!!",
    })).toBe(join(
      getPlansDirectory({ sessionId, agencHome }),
      "safe-plan-agent-unknown.md",
    ));
  });

  test("restores persisted slug after the in-memory cache is cleared", () => {
    const sessionId = "session-persisted";
    const slug = "steady-bridge-deadbeef";
    setPlanSlug({ sessionId, agencHome }, slug);
    clearAllPlanSlugs();

    expect(getPlanFilePath({ sessionId, agencHome })).toBe(
      join(getPlansDirectory({ sessionId, agencHome }), `${slug}.md`),
    );
    expect(isSessionPlanFile(
      getPlanFilePath({ sessionId, agencHome }),
      { sessionId, agencHome },
    )).toBe(true);
  });

  test("copies plan content for resumed sessions while preserving independent slugs", () => {
    const source = { sessionId: "session-source", agencHome };
    const target = { sessionId: "session-target", agencHome };
    setPlanSlug(source, "source-plan-11111111");
    setPlanSlug(target, "target-plan-22222222");
    writePlanSync(source, "# Plan\n\nOriginal content.");

    const copiedPath = copyPlanForResume(source, target);

    expect(copiedPath).toBe(getPlanFilePath(target));
    expect(getPlan(target)).toBe("# Plan\n\nOriginal content.");
    expect(getPlanFilePath(source)).not.toBe(getPlanFilePath(target));
  });

  test("copyPlanForResume no-ops for identical source and target path", () => {
    const ctx = { sessionId: "same-session", agencHome };
    setPlanSlug(ctx, "same-plan");
    writePlanSync(ctx, "# Plan\n\nSame session.");

    expect(copyPlanForResume(ctx, ctx)).toBe(getPlanFilePath(ctx));
    expect(getPlan(ctx)).toBe("# Plan\n\nSame session.");
  });

  test("copyPlanForResume returns null when no source or transcript plan exists", () => {
    const source = { sessionId: "missing-source", agencHome };
    const target = { sessionId: "missing-target", agencHome };
    setPlanSlug(source, "missing-source-plan");
    setPlanSlug(target, "missing-target-plan");

    expect(copyPlanForResume(source, target)).toBeNull();
  });

  test("getPlan treats empty and missing files as no plan", () => {
    const ctx = { sessionId: "empty-plan", agencHome };
    setPlanSlug(ctx, "empty-plan-slug");
    mkdirSync(getPlansDirectory(ctx), { recursive: true });
    writeFileSync(getPlanFilePath(ctx), "", "utf8");

    expect(getPlan(ctx)).toBeNull();
    expect(getPlan({ sessionId: "missing-plan", agencHome })).toBeNull();
  });

  test("writePlan writes asynchronously and formatPlanText renders editor hint", async () => {
    const ctx = { sessionId: "async-plan", agencHome };
    setPlanSlug(ctx, "async-plan-slug");

    const path = await writePlan(ctx, "# Async\n\nDo it.");

    expect(path).toBe(getPlanFilePath(ctx));
    expect(getPlan(ctx)).toBe("# Async\n\nDo it.");
    expect(formatPlanText("# Async", path)).toContain(
      'Use "/plan open" to edit this plan in your configured editor.',
    );
  });

  test("recovers plan content from post-compact plan_file_reference attachments", () => {
    const recovered = recoverPlanFromMessages([
      { type: "agent_message", payload: { message: "older" } },
      {
        type: "attachment",
        attachment: {
          type: "plan_file_reference",
          planFilePath: "/tmp/agenc/plans/session.md",
          planContent: "# Recovered Plan\n\nDo the work.",
        },
      },
    ]);

    expect(recovered).toBe("# Recovered Plan\n\nDo the work.");
  });

  test("recovers plan content from nested JSON and ExitPlanMode records", () => {
    expect(recoverPlanFromMessages([
      {
        payload: JSON.stringify({
          toolName: "ExitPlanMode",
          arguments: JSON.stringify({ plan: "# Args Plan" }),
        }),
      },
    ])).toBe("# Args Plan");

    expect(recoverPlanFromMessages([
      {
        message: {
          content: [
            {
              type: "plan_file_reference",
              plan_content: "# Nested Plan",
            },
          ],
        },
      },
    ])).toBe("# Nested Plan");

    expect(recoverPlanFromMessages([{ payload: "{not-json" }])).toBeNull();
  });

  test("copyPlanForResume writes recovered plan content when the source file is missing", () => {
    const source = { sessionId: "missing-source", agencHome };
    const target = { sessionId: "recovered-target", agencHome };
    setPlanSlug(source, "missing-source-plan");
    setPlanSlug(target, "target-plan-33333333");

    const copiedPath = copyPlanForResume(source, target, {
      messages: [
        {
          msg: {
            type: "attachment",
            payload: {
              attachment: {
                type: "plan_file_reference",
                planContent: "# Transcript Plan\n\nRecovered.",
              },
            },
          },
        },
      ],
    });

    expect(copiedPath).toBe(getPlanFilePath(target));
    expect(getPlan(target)).toBe("# Transcript Plan\n\nRecovered.");
  });
});
