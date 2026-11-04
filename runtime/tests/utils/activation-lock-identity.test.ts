import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, vi } from "vitest";

import { itWhen } from "../helpers/platform-registration.js";

const account = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (importOriginal) => {
  const os = await importOriginal<typeof import("node:os")>();
  return {
    ...os,
    userInfo: () => ({
      ...os.userInfo(),
      homedir: account.home || process.env.AGENC_TEST_HERMETIC_HOME,
    }),
  };
});

const itOnPosix = itWhen(process.platform === "linux" || process.platform === "darwin");
const registrySegments = process.platform === "darwin"
  ? ["Library", "Application Support", "AgenC", "activation-locks"]
  : [".local", "state", "AgenC", "activation-locks"];
let root: string;

beforeEach(() => {
  vi.resetModules();
  root = realpathSync(mkdtempSync(join(tmpdir(), "agenc-activation-permissions-")));
  account.home = join(root, "account");
  mkdirSync(account.home, { mode: 0o700 });
});

afterEach(() => {
  account.home = "";
  rmSync(root, { recursive: true, force: true });
});

for (const scenario of [
  { name: "account home", segments: [], mode: 0o775 },
  { name: "group-writable state directory", segments: registrySegments.slice(0, 2), mode: 0o775 },
  { name: "world-writable registry directory", segments: registrySegments.slice(0, 3), mode: 0o777 },
  {
    name: "directory with shell metacharacters",
    segments: registrySegments.slice(0, 2),
    mode: 0o775,
    homeName: "Joey's $(touch injected); home",
  },
]) {
  itOnPosix("reports the path, permissions, and working repair command for " + scenario.name, async () => {
    if (scenario.homeName) {
      account.home = join(root, scenario.homeName);
      mkdirSync(account.home, { mode: 0o700 });
    }
    const directory = join(account.home, ...scenario.segments);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, scenario.mode);
    const before = statSync(directory);
    const { resolveActivationLockRegistry } = await import("../../src/utils/activation-lock-identity.js");

    let message = "";
    try {
      resolveActivationLockRegistry();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      message = error.message;
    }

    const label = scenario.segments.length === 0 ? "account home" : "activation lock registry path";
    const [diagnostic, remedy] = message.split("\n");
    expect(diagnostic).toBe(
      label + " is group/world writable: " + directory +
      " (permissions 0" + scenario.mode.toString(8) + ")",
    );
    expect(statSync(directory).mode & 0o7777).toBe(scenario.mode);
    expect(remedy).toMatch(/^To fix, run: chmod go-w /u);

    execFileSync("/bin/sh", ["-c", remedy!.slice("To fix, run: ".length)], { cwd: root });
    expect(statSync(directory).mode & 0o7777).toBe(scenario.mode & ~0o022);
    expect(statSync(directory).uid).toBe(before.uid);
    expect(existsSync(join(root, "injected"))).toBe(false);
    expect(resolveActivationLockRegistry()).toBe(join(account.home, ...registrySegments));
  });
}
