import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("session rollout retention docs", () => {
  it("documents the landed sweep window, keeps, log line, and startup quarantine", async () => {
    const text = await readFile("../docs/reference/daemon.md", "utf8");

    expect(text).toContain("## Session rollout retention");
    expect(text).toContain("newest rollout file mtime");
    expect(text).toContain("agent.retention.rollout_days");
    expect(text).toContain("**30**");
    expect(text).toContain("keeps every session");
    expect(text).toContain("**30 s**");
    expect(text).toContain("**50**");
    expect(text).toContain("DEFAULT_ROLLOUT_PRUNE_MAX_DELETIONS");
    expect(text).toContain("does not pin a live session by id");
    expect(text).toContain("sessionHasLiveRolloutLock");
    expect(text).toContain("sessionHasPendingEffectReview");
    expect(text).toContain("review_status = 'pending'");
    expect(text).toContain("compaction_retention_pins.state != 'released'");
    expect(text).toContain("reason `retention`");
    expect(text).toContain("daemon rollout retention deleted");
    expect(text).toContain("first **20**");
    expect(text).toContain("recoverPendingEffectReviewsOnStartup");
    expect(text).toContain('reasonCode: "source_changed"');
    expect(text).toContain("MISSING_RECOVERY_SOURCE_SHA256");
    expect(text).toContain("64 zero hex digits");
    expect(text).toContain("does **not** refuse startup");
    expect(text).toContain("agenc state recovery quarantine list --state active --json");
  });

  it("points config, CLI, architecture, and durable-run pages at the same contract", async () => {
    const [config, cli, architecture, durable, index] = await Promise.all([
      readFile("../docs/reference/config.md", "utf8"),
      readFile("../docs/reference/cli.md", "utf8"),
      readFile("../docs/ARCHITECTURE.md", "utf8"),
      readFile("../docs/design/durable-runs-effects-events.md", "utf8"),
      readFile("../docs/INDEX.md", "utf8"),
    ]);

    expect(config).toContain("daemon.md#session-rollout-retention");
    expect(config).toContain("Newest-rollout-mtime window");
    expect(cli).toContain("daemon.md#session-rollout-retention");
    expect(cli).toContain('reasonCode: "source_changed"');
    expect(cli).toContain("agenc config set agent.retention.rollout_days 0");
    expect(architecture).toContain("reference/daemon.md#session-rollout-retention");
    expect(durable).toContain("../reference/daemon.md#session-rollout-retention");
    expect(durable).toContain("review_status = pending");
    expect(index).toContain("session rollout retention");
  });
});
