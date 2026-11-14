import "../helpers/cron-os-home.js";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { renderGeneratedWrapper } from "../../src/bin/update-cli.js";

// The generated wrapper puts the directory of its Node first on PATH. On macOS
// that is AGENC_HOME/bin, so an older `agenc` there runs before the wrapper
// inside AgenC sessions. The installer retires it only when it is an exact
// AgenC installer wrapper for the same AGENC_HOME.
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agenc-retire-shadow-")));
  roots.push(root);
  const home = join(root, "home", ".agenc");
  mkdirSync(join(home, "bin"), { recursive: true, mode: 0o700 });
  mkdirSync(join(home, "runtime"), { recursive: true, mode: 0o700 });
  const runtimeBin = (version: string) => {
    const path = join(home, "runtime", version, "tree", "node_modules/@tetsuo-ai/runtime/bin/agenc");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `console.log(${JSON.stringify(version)});`);
    return path;
  };
  const stableNode = join(home, "bin", "agenc-node");
  writeFileSync(stableNode, "#!/bin/sh\n", { mode: 0o755 });
  const activeWrapper = join(root, "prefix", "bin", "agenc");
  mkdirSync(dirname(activeWrapper), { recursive: true, mode: 0o700 });
  writeFileSync(
    activeWrapper,
    renderGeneratedWrapper({ kind: "posix", nodeBin: stableNode, runtimeBin: runtimeBin("0.19.34"), agencHome: home }),
    { mode: 0o755 },
  );
  return { root, home, activeWrapper, shadow: join(home, "bin", "agenc"), runtimeBin };
}

function retire(activeWrapper: string, home: string) {
  const helper = resolve("../scripts/install/runtime-installer.cjs");
  return spawnSync(process.execPath, [helper, "retire-shadowing-wrapper", activeWrapper, home], {
    env: { ...process.env, HOME: dirname(home), AGENC_HOME: home },
    encoding: "utf8",
  });
}

describe.skipIf(process.platform === "win32")("installer retirement of an older agenc next to the AgenC Node", () => {
  test("renames aside an exact AgenC wrapper for the same AGENC_HOME", () => {
    const { home, activeWrapper, shadow, runtimeBin } = fixture();
    const legacy = renderGeneratedWrapper({
      kind: "posix",
      nodeBin: join(home, "bin", "agenc-node"),
      runtimeBin: runtimeBin("0.19.20"),
      agencHome: home,
    });
    writeFileSync(shadow, legacy, { mode: 0o755 });

    const result = retire(activeWrapper, home);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`retired an older AgenC launcher that came before the current one inside AgenC sessions: ${shadow}`);
    expect(existsSync(shadow)).toBe(false);
    const retired = readdirSync(join(home, "bin")).filter((name) => name.startsWith("agenc.retired-"));
    expect(retired).toHaveLength(1);
    expect(readFileSync(join(home, "bin", retired[0]!), "utf8")).toBe(legacy);
    expect(result.stdout).toContain(`(kept as ${join(home, "bin", retired[0]!)})`);
  });

  test("leaves a user-written agenc alone and says so", () => {
    const { home, activeWrapper, shadow } = fixture();
    const mine = "#!/bin/sh\nexec /opt/my-agenc \"$@\"\n";
    writeFileSync(shadow, mine, { mode: 0o755 });

    const result = retire(activeWrapper, home);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`NOTE: ${shadow} comes before the AgenC launcher on PATH inside AgenC sessions`);
    expect(result.stdout).toContain("left as is");
    expect(readFileSync(shadow, "utf8")).toBe(mine);
    expect(readdirSync(join(home, "bin")).some((name) => name.startsWith("agenc.retired-"))).toBe(false);
  });

  test("leaves an AgenC wrapper that serves a different AGENC_HOME alone", () => {
    const { root, home, activeWrapper, shadow, runtimeBin } = fixture();
    const otherHome = join(root, "other", ".agenc");
    mkdirSync(otherHome, { recursive: true, mode: 0o700 });
    const foreign = renderGeneratedWrapper({
      kind: "posix",
      nodeBin: join(home, "bin", "agenc-node"),
      runtimeBin: runtimeBin("0.19.20"),
      agencHome: otherHome,
    });
    writeFileSync(shadow, foreign, { mode: 0o755 });

    const result = retire(activeWrapper, home);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("left as is");
    expect(readFileSync(shadow, "utf8")).toBe(foreign);
  });

  test("does nothing when no agenc sits next to the AgenC Node", () => {
    const { home, activeWrapper, shadow } = fixture();

    const result = retire(activeWrapper, home);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
    expect(existsSync(shadow)).toBe(false);
  });

  test("refuses when the active wrapper is not an AgenC installer wrapper", () => {
    const { home, activeWrapper } = fixture();
    writeFileSync(activeWrapper, "#!/bin/sh\necho not ours\n", { mode: 0o755 });

    const result = retire(activeWrapper, home);

    expect(result.status).not.toBe(0);
  });
});
