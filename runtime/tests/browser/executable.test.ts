/**
 * Snap packages cannot start inside AgenC's Linux sandbox (Ubuntu 26.04, 2026-10-15). /snap/bin/chromium links
 * to the `snap` launcher, which the sandbox runs under its real name, so it parsed Chromium's flags as its own
 * ("error: unknown flag `no-sandbox'"). A script that runs /snap/bin/chromium reaches `snap run`, which cannot
 * create its systemd scope for a sandboxed process. Detection passes over both there, and a configured one is
 * refused before launch. These layouts copy snapd's: the link's real file is named `snap`.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BrowserExecutableError,
  resolveBrowserExecutable,
  SNAP_IN_SANDBOX_HINT,
  startsSnapPackage,
} from "../../src/browser/executable.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agenc-browser-executable-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function executable(relative: string, content: string): string {
  const file = join(root, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  chmodSync(file, 0o755);
  return file;
}

function link(relative: string, target: string): string {
  const file = join(root, relative);
  mkdirSync(dirname(file), { recursive: true });
  symlinkSync(target, file);
  return file;
}

/** snapd's layout: the launcher binary, and each app a link to it. */
function snapChromium(): string {
  const launcher = executable("usr/bin/snap", "\u007fELF snapd launcher");
  return link("snap/bin/chromium", launcher);
}

function thrown(run: () => unknown): BrowserExecutableError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(BrowserExecutableError);
    return error as BrowserExecutableError;
  }
  throw new Error("expected a BrowserExecutableError");
}

const inSandbox = { insideAgencSandbox: true, platform: "linux" } as const;
const outsideSandbox = { insideAgencSandbox: false, platform: "linux" } as const;

describe.skipIf(process.platform === "win32")("browser executable resolution and snap packages", () => {
  it("passes over a snap inside AgenC's Linux sandbox when a non-snap Chromium comes later", () => {
    const snap = snapChromium();
    const plain = executable("home/bin/chromium", "#!/bin/sh\nexec /opt/chromium/chrome \"$@\"\n");
    const binDirs = [join(root, "usr/bin"), dirname(snap)];
    const env = { PATH: dirname(plain) };

    expect(resolveBrowserExecutable(undefined, env, { ...inSandbox, linuxBinDirs: binDirs })).toBe(plain);
    // Outside the sandbox the detection order is unchanged.
    expect(resolveBrowserExecutable(undefined, env, { ...outsideSandbox, linuxBinDirs: binDirs })).toBe(snap);
  });

  it("fails with the snap message inside the sandbox when the only browser found is a snap", () => {
    const snap = snapChromium();

    const error = thrown(() =>
      resolveBrowserExecutable(undefined, { PATH: "" }, { ...inSandbox, linuxBinDirs: [dirname(snap)] }));

    expect(error.message).toBe(`${snap} is a snap package. ${SNAP_IN_SANDBOX_HINT}`);
    expect(error.message).toBe(
      `${snap} is a snap package. Snap packages cannot start inside AgenC's sandbox. ` +
        "Install Google Chrome or a non-snap Chromium, or set [browser].executable_path to one.",
    );
    expect(error.code).toBe("BROWSER_EXECUTABLE_SNAP_IN_SANDBOX");
  });

  it("refuses a configured snap inside the sandbox and keeps it outside", () => {
    const snap = snapChromium();

    const error = thrown(() => resolveBrowserExecutable(snap, {}, inSandbox));

    expect(error.message).toBe(`${snap} is a snap package. ${SNAP_IN_SANDBOX_HINT}`);
    expect(resolveBrowserExecutable(snap, {}, outsideSandbox)).toBe(snap);
    expect(resolveBrowserExecutable(snap, {}, { insideAgencSandbox: true, platform: "darwin" })).toBe(snap);
  });

  it("treats a script that runs /snap/bin/chromium as a snap, like Ubuntu's chromium-browser", () => {
    const snap = snapChromium();
    const wrapper = executable(
      "usr/bin/chromium-browser",
      "#!/bin/sh\nif ! [ -x /snap/bin/chromium ]; then\n  exit 1\nfi\nexec /snap/bin/chromium \"$@\"\n",
    );

    expect(startsSnapPackage(wrapper)).toBe(true);
    expect(thrown(() => resolveBrowserExecutable(wrapper, {}, inSandbox)).message)
      .toBe(`${wrapper} is a snap package. ${SNAP_IN_SANDBOX_HINT}`);
    // Detection reports the first snap it passed over.
    expect(thrown(() =>
      resolveBrowserExecutable(undefined, { PATH: "" }, {
        ...inSandbox,
        linuxBinDirs: [dirname(wrapper), dirname(snap)],
      })).message).toBe(`${snap} is a snap package. ${SNAP_IN_SANDBOX_HINT}`);
  });

  it("keeps the browser binary inside a snap's own directory, which starts in the sandbox", () => {
    // /snap/chromium/current/usr/lib/chromium-browser/chrome ran the live suite inside the sandbox.
    const inner = executable("snap/chromium/3554/usr/lib/chromium-browser/chrome", "\u007fELF chromium");
    const current = link("snap/chromium/current", join(root, "snap/chromium/3554"));
    const configured = join(current, "usr/lib/chromium-browser/chrome");

    expect(startsSnapPackage(configured)).toBe(false);
    expect(resolveBrowserExecutable(configured, {}, inSandbox)).toBe(configured);
    expect(startsSnapPackage(inner)).toBe(false);
  });

  it("keeps wrapper scripts that do not run a snap", () => {
    const chrome = executable(
      "opt/google/chrome/google-chrome",
      "#!/bin/bash\nHERE=\"/opt/google/chrome\"\nexec -a \"$0\" \"$HERE/chrome\" \"$@\"\n",
    );
    const alternative = link("usr/bin/google-chrome", chrome);

    expect(startsSnapPackage(alternative)).toBe(false);
    expect(resolveBrowserExecutable(alternative, {}, inSandbox)).toBe(alternative);
  });

  it("does not block on a FIFO in a search directory", () => {
    const fifo = join(root, "usr/bin/chromium");
    mkdirSync(dirname(fifo), { recursive: true });
    execFileSync("mkfifo", [fifo]);

    expect(startsSnapPackage(fifo)).toBe(false);
  });
});
