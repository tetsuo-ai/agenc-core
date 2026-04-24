import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  extractAgencAliasTarget,
  filterAgencAliases,
  findAgencAlias,
  findValidAgencAlias,
  getShellConfigPaths,
  readFileLines,
} from "./shell-config.js";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "agenc-shell-config-"));
}

describe("shell config utilities", () => {
  it("honors ZDOTDIR for zsh and standard bash/fish locations", () => {
    const home = "/home/alice";
    const paths = getShellConfigPaths({
      homedir: home,
      env: { ZDOTDIR: "/home/alice/.config/zsh" },
    });
    expect(paths).toEqual({
      zsh: "/home/alice/.config/zsh/.zshrc",
      bash: "/home/alice/.bashrc",
      fish: "/home/alice/.config/fish/config.fish",
    });
  });

  it("extracts quoted and bare agenc aliases", () => {
    expect(extractAgencAliasTarget('alias agenc="/opt/agenc/bin/agenc"')).toBe(
      "/opt/agenc/bin/agenc",
    );
    expect(extractAgencAliasTarget("alias agenc=/opt/agenc/bin/agenc # cli")).toBe(
      "/opt/agenc/bin/agenc",
    );
    expect(extractAgencAliasTarget("alias other=/opt/agenc/bin/agenc")).toBeNull();
  });

  it("filters only installer-owned agenc aliases", () => {
    const result = filterAgencAliases(
      [
        'alias agenc="/opt/agenc/bin/agenc"',
        'alias agenc="/custom/agenc"',
        "export PATH=$PATH:/opt/agenc/bin",
      ],
      { installerPath: "/opt/agenc/bin/agenc" },
    );

    expect(result.hadAlias).toBe(true);
    expect(result.filtered).toEqual([
      'alias agenc="/custom/agenc"',
      "export PATH=$PATH:/opt/agenc/bin",
    ]);
  });

  it("returns null for missing shell config files", async () => {
    expect(await readFileLines(join(tmpHome(), ".zshrc"))).toBeNull();
  });

  it("finds the first agenc alias across shell config files", async () => {
    const home = tmpHome();
    writeFileSync(join(home, ".bashrc"), 'alias agenc="/usr/local/bin/agenc"\n');

    await expect(findAgencAlias({ homedir: home, env: {} })).resolves.toBe(
      "/usr/local/bin/agenc",
    );
  });

  it("validates alias targets after expanding home-relative paths", async () => {
    const home = tmpHome();
    const binDir = join(home, "bin");
    mkdirSync(binDir);
    const target = join(binDir, "agenc");
    writeFileSync(target, "#!/bin/sh\n");
    chmodSync(target, 0o755);
    writeFileSync(join(home, ".zshrc"), 'alias agenc="~/bin/agenc"\n');

    await expect(findValidAgencAlias({ homedir: home, env: {} })).resolves.toBe(
      "~/bin/agenc",
    );
  });
});
