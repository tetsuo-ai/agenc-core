import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const READ_ONLY =
  "A tool action was blocked by this routine's read-only permissions. Update its instructions to use only read-only actions, then run it again. Open its session for details.";
const ACCEPT_EDITS =
  "A tool action needed approval, and nobody is attached to a scheduled run to give it. This routine may edit files in its workspace without asking; anything else that needs approval is refused. Open its session for details.";
const BYPASS =
  "A tool action was refused: this routine writes files only inside its workspace, and nothing it asks for can be approved while it runs unattended. Open its session for details.";
const GENERIC_CORE_FAILURE =
  "Core could not complete this run. Open its session for details.";
const UNKNOWN_OUTCOME =
  "An action's outcome could not be confirmed. Open the session for details.";

/** Markdown prose wraps at any space; compare sentences with whitespace collapsed. */
function flat(text: string): string {
  return text.replace(/\s+/g, " ");
}

describe("routine permission-blocked explanation docs", () => {
  it("pins the shipped mode strings and Core stop-reason writers", async () => {
    const [service, runner] = await Promise.all([
      readFile("src/routines/service.ts", "utf8"),
      readFile("src/app-server/background-agent-runner.ts", "utf8"),
    ]);

    expect(service).toContain("function describePermissionDenial");
    expect(service).toContain(READ_ONLY);
    expect(service).toContain(ACCEPT_EDITS);
    expect(service).toContain(BYPASS);
    expect(service).toContain('outcome === "permission_denied"');
    expect(service).toContain('payload.stopReason === "routine_permission_denied"');
    expect(service).toContain(GENERIC_CORE_FAILURE);
    expect(service).toContain(UNKNOWN_OUTCOME);
    expect(service).toContain("describeRunFailure");

    expect(runner).toContain('cause.startsWith("permission_denied:")');
    expect(runner).toContain("permissionDenied = true");
    expect(runner).toContain('"routine_permission_denied"');
    expect(runner).toContain("finishAgentRun");
    expect(runner).toContain("#applyCanonicalEventBookkeeping");
  });

  it("documents the mode table, writers, and distinct failures in agents.md", async () => {
    const agents = await readFile("../docs/reference/agents.md", "utf8");

    expect(agents).toContain("#### Permission-blocked explanation");
    expect(agents).toContain("`describePermissionDenial`");
    expect(agents).toContain("`default` or `plan`");
    expect(agents).toContain("`acceptEdits`");
    expect(agents).toContain("`bypassPermissions`");
    expect(agents).toContain(READ_ONLY);
    expect(agents).toContain(ACCEPT_EDITS);
    expect(agents).toContain(BYPASS);
    expect(agents).toContain("`snapshot.permissionMode`");
    expect(agents).toContain("`stopReason: \"routine_permission_denied\"`");
    expect(agents).toContain("`permission_denied:`");
    expect(agents).toContain("`finishAgentRun`");
    expect(agents).toContain("`#applyCanonicalEventBookkeeping`");
    expect(agents).toContain("There is no env or");
    expect(agents).toContain("`config.toml` override");
    expect(agents).toContain("`describeRunFailure`");
    expect(agents).toContain(GENERIC_CORE_FAILURE);
    expect(agents).toContain(UNKNOWN_OUTCOME);
    expect(flat(agents)).toContain(
      "Those are not permission-blocked explanations.",
    );
  });

  it("points INDEX, architecture, daemon, autonomy, env, config, and sandbox at the same contract", async () => {
    const [index, architecture, daemon, autonomy, env, config, sandbox] =
      await Promise.all([
        readFile("../docs/INDEX.md", "utf8"),
        readFile("../docs/ARCHITECTURE.md", "utf8"),
        readFile("../docs/reference/daemon.md", "utf8"),
        readFile("../docs/reference/autonomy.md", "utf8"),
        readFile("../docs/reference/env.md", "utf8"),
        readFile("../docs/reference/config.md", "utf8"),
        readFile("../docs/reference/tools-permissions-sandbox.md", "utf8"),
      ]);

    expect(index).toContain("agents.md#permission-blocked-explanation");
    expect(architecture).toContain("### Routine permission-blocked explanation");
    expect(architecture).toContain(
      "agents.md#permission-blocked-explanation",
    );
    expect(architecture).toContain("`describePermissionDenial`");
    expect(architecture).toContain("`routine_permission_denied`");
    expect(architecture).toContain("There is no env or `config.toml` override");
    expect(architecture).toContain("`routines/routines-v1.json`");
    expect(daemon).toContain("agents.md#permission-blocked-explanation");
    expect(autonomy).toContain("agents.md#permission-blocked-explanation");
    expect(env).toContain("agents.md#permission-blocked-explanation");
    expect(flat(env)).toContain("have no `AGENC_*` override");
    expect(config).toContain("agents.md#permission-blocked-explanation");
    expect(flat(config)).toContain("there is no `config.toml` override");
    expect(sandbox).toContain("agents.md#permission-blocked-explanation");
  });
});
