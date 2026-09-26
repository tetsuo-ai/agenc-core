import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  withPinnedOfflineRolloutLease,
  withPinnedOfflineRolloutReadLease,
} from "../../src/durability/offline-rollout.js";

const created: string[] = [];

afterEach(() => {
  for (const path of created.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function fixture(rootName: "sessions" | "archived_sessions" = "sessions") {
  const root = mkdtempSync(join(tmpdir(), "agenc-offline-rollout-"));
  created.push(root);
  const projectDir = join(root, "project");
  const sessionId = "session-1";
  const sessionDirectory = join(projectDir, rootName, sessionId);
  const sourcePath = join(
    sessionDirectory,
    "rollout-2026-07-18T00-00-00-000Z-session-1.jsonl",
  );
  mkdirSync(sessionDirectory, { recursive: true });
  writeFileSync(sourcePath, "committed\n", { mode: 0o600 });
  return { root, projectDir, sessionId, sessionDirectory, sourcePath };
}

/**
 * Report the platform as win32 to the descriptor probe. Windows has no
 * descriptor filesystem (/proc/self/fd, /dev/fd), so no alias can name a
 * pinned directory there; the identity-proven canonical path must, and the
 * swap checks must still hold on it.
 */
function asWindows<T>(run: () => T): T {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  try {
    return run();
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
}

const PIN_PATHS = [
  ["as this host pins", <T>(run: () => T): T => run()],
  ["as Windows pins, with no descriptor alias", asWindows],
] as const;

describe.skipIf(process.platform === "win32")(
  "descriptor-pinned offline rollout mutation",
  () => {
    it.each(["sessions", "archived_sessions"] as const)(
      "accepts only an exact regular rollout below %s",
      (rootName) => {
        const target = fixture(rootName);
        withPinnedOfflineRolloutLease(target, (rollout) => {
          expect(rollout.readUtf8()).toBe("committed\n");
          rollout.appendAndSync("review\n");
        });
        expect(readFileSync(target.sourcePath, "utf8")).toBe(
          "committed\nreview\n",
        );
      },
    );

    it("reports the pinned file's exact device and inode numbers", () => {
      const target = fixture();
      const expected = statSync(target.sourcePath, { bigint: true });
      withPinnedOfflineRolloutLease(target, (rollout) => {
        expect(rollout.identity()).toEqual({
          dev: expected.dev.toString(10),
          ino: expected.ino.toString(10),
        });
      });
    });

    it("rejects an external binding and a source symlink without touching the target", () => {
      const target = fixture();
      const external = join(
        target.root,
        "rollout-2026-07-18T00-00-00-000Z-external.jsonl",
      );
      writeFileSync(external, "external\n", { mode: 0o600 });

      expect(() =>
        withPinnedOfflineRolloutLease(
          { ...target, sourcePath: external },
          (rollout) => rollout.appendAndSync("must-not-append\n"),
        ),
      ).toThrow(/outside this project's sessions\/archived_sessions roots/);

      rmSync(target.sourcePath);
      symlinkSync(external, target.sourcePath);
      expect(() =>
        withPinnedOfflineRolloutLease(target, (rollout) =>
          rollout.appendAndSync("must-not-append\n"),
        ),
      ).toThrow(/source must be one regular, non-linked file/);
      expect(readFileSync(external, "utf8")).toBe("external\n");
    });

    it.each(PIN_PATHS)("rejects a source replacement after the lease without writing either inode (%s)", (_label, pinnedThrough) => {
      const target = fixture();
      const original = join(target.sessionDirectory, "original.jsonl");

      expect(() =>
        pinnedThrough(() => withPinnedOfflineRolloutLease(target, (rollout) => {
          renameSync(target.sourcePath, original);
          writeFileSync(target.sourcePath, "replacement\n", { mode: 0o600 });
          rollout.appendAndSync("must-not-append\n");
        })),
      ).toThrow(/source changed during offline mutation/);
      expect(readFileSync(original, "utf8")).toBe("committed\n");
      expect(readFileSync(target.sourcePath, "utf8")).toBe("replacement\n");
    });

    it.each(PIN_PATHS)("rejects a parent replacement after the lease without following it (%s)", (_label, pinnedThrough) => {
      const target = fixture();
      const originalDirectory = join(target.root, "original-session");

      expect(() =>
        pinnedThrough(() => withPinnedOfflineRolloutLease(target, (rollout) => {
          renameSync(target.sessionDirectory, originalDirectory);
          mkdirSync(target.sessionDirectory);
          writeFileSync(
            join(target.sessionDirectory, basename(target.sourcePath)),
            "replacement\n",
            { mode: 0o600 },
          );
          rollout.appendAndSync("must-not-append\n");
        })),
      ).toThrow(/directory changed during offline mutation/);
      expect(
        readFileSync(
          join(originalDirectory, basename(target.sourcePath)),
          "utf8",
        ),
      ).toBe("committed\n");
      expect(readFileSync(target.sourcePath, "utf8")).toBe("replacement\n");
    });

    it("scans past a partial tail larger than one MiB without losing the committed prefix", () => {
      const target = fixture();
      writeFileSync(
        target.sourcePath,
        `committed\n${"x".repeat(1024 * 1024 + 257)}`,
        { mode: 0o600 },
      );

      withPinnedOfflineRolloutLease(target, (rollout) => {
        expect(rollout.readUtf8()).toBe("committed\n");
        rollout.appendAndSync("review\n");
      });
      expect(readFileSync(target.sourcePath, "utf8")).toBe(
        "committed\nreview\n",
      );
    });

    it("keeps an unterminated tail intact under the strict read-only lease", () => {
      const target = fixture();
      writeFileSync(target.sourcePath, "committed\npartial", { mode: 0o600 });
      const chunks: Buffer[] = [];

      withPinnedOfflineRolloutReadLease(target, (rollout) => {
        const snapshot = rollout.stat();
        rollout.scanChunks(3, (chunk) => chunks.push(Buffer.from(chunk)));
        rollout.assertSnapshot(snapshot);
      });

      expect(Buffer.concat(chunks).toString("utf8")).toBe("committed\npartial");
      expect(readFileSync(target.sourcePath, "utf8")).toBe(
        "committed\npartial",
      );
    });
  },
);

// Before the identity-proven canonical path covered Windows, every offline read
// refused there, and every daemon start on Windows excluded every open chat as
// "pending operator recovery action". The swap refusals above run this path too.
describe("descriptor-pinned offline rollout where no descriptor alias exists", () => {
  it("scans a rollout through the identity-proven canonical path", () => {
    const target = fixture();
    const chunks: Buffer[] = [];

    asWindows(() =>
      withPinnedOfflineRolloutReadLease(target, (rollout) => {
        const snapshot = rollout.stat();
        rollout.scanChunks(4, (chunk) => chunks.push(Buffer.from(chunk)));
        rollout.assertSnapshot(snapshot);
      }),
    );

    expect(Buffer.concat(chunks).toString("utf8")).toBe("committed\n");
  });

  it("appends through the identity-proven canonical path", () => {
    const target = fixture();

    asWindows(() =>
      withPinnedOfflineRolloutLease(target, (rollout) => {
        expect(rollout.readUtf8()).toBe("committed\n");
        rollout.appendAndSync("review\n");
      }),
    );

    expect(readFileSync(target.sourcePath, "utf8")).toBe("committed\nreview\n");
  });
});
