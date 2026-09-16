import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { MAX_COMPACTION_ABORT_QUIESCENCE_MS, MAX_COMPACTION_WALL_MS } from "../../../src/services/compact/transaction-types.js";

describe("compaction wall-budget docs", () => {
  it("pins the shipped 900 s bound and operator symptoms", async () => {
    expect(MAX_COMPACTION_WALL_MS).toBe(900_000);
    expect(MAX_COMPACTION_ABORT_QUIESCENCE_MS).toBe(5_000);

    const contract = await readFile(
      "../docs/design/critical-path/0006-compaction-transaction.md",
      "utf8",
    );
    const daemon = await readFile("../docs/reference/daemon.md", "utf8");
    const cli = await readFile("../docs/reference/cli.md", "utf8");

    expect(contract).toContain("### Compaction transaction wall budget");
    expect(contract).toContain("**900 seconds**");
    expect(contract).toContain("`MAX_COMPACTION_WALL_MS`");
    expect(contract).toContain("not an environment or `config.toml` override");
    expect(contract).toContain("`reason: \"wall_time_exceeded\"`");
    expect(contract).toContain("`compaction_wall_time_exceeded`");
    expect(contract).toContain("`MAX_COMPACTION_ABORT_QUIESCENCE_MS`");
    expect(contract).toContain("recovery_interrupted");
    expect(contract).toContain("former 300 s bound");
    expect(contract).toContain("not `provider_timeout`");
    expect(contract).toContain("not `mid_turn_compact_skipped`");

    expect(daemon).toContain("### Compaction transaction wall budget");
    expect(daemon).toContain("900 s");
    expect(daemon).toContain("`wall_time_exceeded`");
    expect(cli).toContain("900 s");
    expect(cli).toContain("wall_time_exceeded");
  });
});
