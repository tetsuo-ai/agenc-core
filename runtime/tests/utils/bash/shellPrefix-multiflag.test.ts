import { describe, expect, it } from "vitest";

import { formatShellPrefixCommand } from "../../../src/utils/bash/shellPrefix.js";

// shellPrefix minor (core-todo.md): formatShellPrefixCommand split at lastIndexOf(' -'),
// so a multi-flag prefix (AGENC_SHELL_PREFIX="wsl -e bash -c") mis-parsed the executable
// as "wsl -e bash". Fixed by splitting at the FIRST " -".

describe("formatShellPrefixCommand — multi-flag prefix", () => {
  it("keeps only the first token as the executable for a multi-flag prefix", () => {
    // With the fix: exec='wsl', args='-e bash -c'. The pre-fix lastIndexOf split
    // produced the quoted, wrong exec "'wsl -e bash' -c ls".
    expect(formatShellPrefixCommand("wsl -e bash -c", "ls")).toBe("wsl -e bash -c ls");
  });

  it("still handles a single-flag prefix and a space-containing path", () => {
    expect(formatShellPrefixCommand("/usr/bin/bash -c", "ls")).toBe(
      "/usr/bin/bash -c ls",
    );
    // A space in the path forces quoting of the executable only.
    expect(
      formatShellPrefixCommand("C:\\Program Files\\Git\\bin\\bash.exe -c", "ls"),
    ).toBe("'C:\\Program Files\\Git\\bin\\bash.exe' -c ls");
  });

  it("handles a bare executable with no flags", () => {
    expect(formatShellPrefixCommand("bash", "ls")).toBe("bash ls");
  });
});
