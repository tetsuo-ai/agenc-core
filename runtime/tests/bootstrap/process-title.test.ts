import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  cliBootstrapSource as cli,
  launcherBootstrapSource as launcher,
  pgrepSelects,
  processListViews,
  startIdleNodeChild,
  watchdogBootstrapSource as watchdog,
} from "../helpers/agenc-process-bootstrap.js";
import { canonicalTmpdir } from "../helpers/canonical-temp-dir.js";
import { itWhen } from "../helpers/platform-registration.js";

const root = join(__dirname, "../../..");
const sentinel = "px-fake-process-environment-value";

/** Each AgenC process as it starts: CLI and launcher as `node <entry>`, the watchdog as `node -e`. */
function agencProcesses(directory: string) {
  return [
    { name: "cli", source: cli, file: join(directory, "runtime/dist/bin/agenc.js"), linuxTitle: "agenc" },
    { name: "launcher", source: launcher, file: join(directory, "agenc/bin/agenc"), linuxTitle: "agenc-launcher" },
    { name: "watchdog", source: watchdog, file: undefined, linuxTitle: "agenc-process-owner-watchdog" },
  ];
}

const SHIPPED_SOURCE_ROOTS = ["runtime/src", "runtime/bin", "packages/agenc/bin", "packages/agenc/src", "packages/agenc-sdk/src"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"]);
// A native title write, or Node's --title option, which sets the same title at startup.
const TITLE_WRITE = /\bprocess\.title\s*=(?!=)|["'`]--title(?:=|["'`])/g;

function titleWriteSites(): string[] {
  const sites: string[] = [];
  const visit = (directory: string, inBin: boolean) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") visit(path, entry.name === "bin");
        continue;
      }
      const extension = extname(entry.name);
      if (!entry.isFile() || !(SOURCE_EXTENSIONS.has(extension) || (inBin && extension === ""))) continue;
      const count = readFileSync(path, "utf8").match(TITLE_WRITE)?.length ?? 0;
      if (count > 0) sites.push(`${relative(root, path).split(sep).join("/")}: ${count}`);
    }
  };
  for (const sourceRoot of SHIPPED_SOURCE_ROOTS) visit(join(root, sourceRoot), sourceRoot.endsWith("/bin"));
  return sites.sort();
}

describe("process titles preserve the argv/environment boundary", () => {
  it.each(["darwin", "freebsd", "openbsd", "sunos", "aix"])(
    "never calls the native title setter on %s, including the launcher and watchdog",
    platform => {
      for (const source of [cli, launcher, watchdog]) {
        const setTitle = vi.fn();
        const fakeProcess = { platform, env: {} };
        Object.defineProperty(fakeProcess, "title", { set: setTitle });
        runInNewContext(source, { process: fakeProcess, require: () => ({}) });
        expect(setTitle).not.toHaveBeenCalled();
      }
    },
  );

  it("retains the Linux process labels", () => {
    for (const [source, title] of [
      [cli, "agenc"], [launcher, "agenc-launcher"], [watchdog, "agenc-process-owner-watchdog"],
    ]) {
      const setTitle = vi.fn();
      const fakeProcess = { platform: "linux", env: {} };
      Object.defineProperty(fakeProcess, "title", { set: setTitle });
      runInNewContext(source!, { process: fakeProcess, require: () => ({}) });
      expect(setTitle).toHaveBeenCalledWith(title);
    }
  });

  it("writes native titles only at the reviewed, platform-gated sites", () => {
    // On macOS a title write leaves argc unchanged while it rewrites the
    // argument area, so pgrep -lf (and ps, for an empty or full-length title)
    // prints the first environment strings, provider keys included. Gate any
    // new write to Linux or Windows like bin/agenc.ts, cover it in this file,
    // and only then add it here.
    expect(titleWriteSites()).toEqual([
      "packages/agenc/bin/agenc: 1",
      "runtime/src/bin/agenc.ts: 1",
      "runtime/src/tui/ink/hooks/use-terminal-title.ts: 1",
      "runtime/src/utils/gracefulShutdown.ts: 1",
      "runtime/src/utils/supervisedProcess.ts: 1",
    ]);
  });

  itWhen(process.platform === "linux" || process.platform === "darwin")(
    "keeps an inherited fake secret out of ps and pgrep -lf for each live AgenC process",
    async () => {
      const directory = mkdtempSync(join(canonicalTmpdir(), "agenc-title-"));
      try {
        for (const agencProcess of agencProcesses(directory)) {
          // The sentinel is supplied only in env, never in the child argv or code.
          const child = await startIdleNodeChild({ ...agencProcess, env: { SECRET: sentinel } });
          try {
            const views = processListViews(child.pid);
            // pgrep really listed the child, so an absent sentinel means something.
            expect(views.pgrepLines, agencProcess.name).toHaveLength(process.platform === "linux" ? 2 : 1);
            expect(JSON.stringify(views), agencProcess.name).not.toContain(sentinel);
            expect(pgrepSelects(child.pid, sentinel), agencProcess.name).toBe(false);
            if (process.platform === "linux") {
              expect(views.psArgs, agencProcess.name).toBe(agencProcess.linuxTitle);
              expect(readFileSync(`/proc/${child.pid}/cmdline`, "utf8")).not.toContain(sentinel);
              // Positive control: it really was inherited, in the separate environment range.
              expect(readFileSync(`/proc/${child.pid}/environ`, "utf8")).toContain(`SECRET=${sentinel}`);
            } else {
              // No title on macOS: the real argv stays in place.
              expect(views.psArgs.startsWith(`${process.execPath} ${agencProcess.file ?? "-e"}`), agencProcess.name).toBe(true);
            }
          } finally {
            await child.stop();
          }
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  itWhen(process.platform === "darwin")(
    "detects the macOS leak when a title is written, so the live check above is not blind",
    async () => {
      // The bootstrap before the Darwin gate wrote the title on every platform.
      // ps alone shows only the title here; pgrep -lf reads argc strings and
      // skips the cleared argument area, into the environment block. If this
      // control stops leaking, re-verify the live check before trusting it.
      const directory = mkdtempSync(join(canonicalTmpdir(), "agenc-title-control-"));
      const child = await startIdleNodeChild({
        source: 'process.title = "agenc";',
        env: { SECRET: sentinel },
        file: join(directory, "runtime/dist/bin/agenc.js"),
      });
      try {
        expect(processListViews(child.pid).pgrepLines.join("\n")).toContain(`SECRET=${sentinel}`);
        expect(pgrepSelects(child.pid, sentinel)).toBe(true);
      } finally {
        await child.stop();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
