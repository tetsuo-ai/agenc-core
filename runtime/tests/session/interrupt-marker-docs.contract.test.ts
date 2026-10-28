import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const MARKER =
  "[The user stopped this response before it finished. Do not continue the previous request unless the user asks you to.]";

/** Markdown prose wraps at any space; compare sentences with whitespace collapsed. */
function flat(text: string): string {
  return text.replace(/\s+/g, " ");
}

describe("interrupted-request stop-marker docs", () => {
  it("pins the shipped marker and abort-reason writers", async () => {
    const [runTurn, tasks] = await Promise.all([
      readFile("src/session/run-turn.ts", "utf8"),
      readFile("src/session/tasks.ts", "utf8"),
    ]);

    expect(runTurn).toContain("const syncAbortedSessionState = async");
    expect(runTurn).toContain('reason === "interrupted"');
    expect(runTurn).toContain(MARKER);
    expect(runTurn).toContain("function turnSignalAbortReason");
    expect(runTurn).toContain('case "daemon_shutdown"');
    expect(runTurn).toContain('case "replaced"');
    expect(runTurn).toContain('case "review_ended"');
    expect(runTurn).toContain("return \"interrupted\"");
    expect(runTurn).toContain("isDeadlineAbort");

    expect(tasks).toContain(
      'export type TurnAbortReason = "interrupted" | "replaced" | "review_ended" | "daemon_shutdown"',
    );
  });

  it("documents the marker, writers, and distinct failures in daemon.md", async () => {
    const daemon = await readFile("../docs/reference/daemon.md", "utf8");

    expect(daemon).toContain("### Interrupted requests as stopped");
    expect(daemon).toContain("`syncAbortedSessionState`");
    expect(daemon).toContain("`runtime/src/session/run-turn.ts`");
    expect(daemon).toContain(MARKER);
    expect(daemon).toContain("`interrupted`");
    expect(daemon).toContain("`replaced`");
    expect(daemon).toContain("`review_ended`");
    expect(daemon).toContain("`daemon_shutdown`");
    expect(daemon).toContain("`deadline_reached`");
    expect(daemon).toContain("`turnSignalAbortReason`");
    expect(daemon).toContain("`cli_subagent`");
    expect(daemon).toContain("There is no env or `config.toml` override");
    expect(daemon).toContain("Interrupted partial answer");
    expect(flat(daemon)).toContain(
      "Distinct from the TUI `Interrupted partial answer` prefix",
    );
    expect(daemon).toContain("`connection_lost`");
    expect(daemon).toContain("#max-output-tokens-recovery");
  });

  it("points INDEX, architecture, agents, cli, env, config, and providers at the same contract", async () => {
    const [index, architecture, agents, cli, env, config, providers] =
      await Promise.all([
        readFile("../docs/INDEX.md", "utf8"),
        readFile("../docs/ARCHITECTURE.md", "utf8"),
        readFile("../docs/reference/agents.md", "utf8"),
        readFile("../docs/reference/cli.md", "utf8"),
        readFile("../docs/reference/env.md", "utf8"),
        readFile("../docs/reference/config.md", "utf8"),
        readFile("../docs/reference/providers.md", "utf8"),
      ]);

    expect(index).toContain("daemon.md#interrupted-requests-as-stopped");
    expect(index).toContain("ARCHITECTURE.md#interrupted-requests-as-stopped");

    expect(architecture).toContain("### Interrupted requests as stopped");
    expect(architecture).toContain(MARKER);
    expect(architecture).toContain("There is no env or `config.toml` override");
    expect(architecture).toContain("daemon.md#interrupted-requests-as-stopped");

    expect(agents).toContain("daemon.md#interrupted-requests-as-stopped");
    expect(cli).toContain("daemon.md#interrupted-requests-as-stopped");
    expect(env).toContain("daemon.md#interrupted-requests-as-stopped");
    expect(flat(env)).toContain("has no `AGENC_*` override");
    expect(config).toContain("daemon.md#interrupted-requests-as-stopped");
    expect(flat(config)).toContain("has no `config.toml` override");
    expect(providers).toContain("daemon.md#interrupted-requests-as-stopped");
  });
});
