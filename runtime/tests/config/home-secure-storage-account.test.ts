import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, expect, test, vi } from "vitest";

const root = mkdtempSync(join(tmpdir(), "agenc-home-account-failure-"));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  vi.doUnmock("node:os");
  vi.resetModules();
});

async function loadHomeWithFailedUserInfo() {
  vi.resetModules();
  vi.doMock("node:os", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:os")>();
    return {
      ...actual,
      userInfo: () => {
        throw new Error("OS account lookup failed");
      },
    };
  });
  return import("../../src/config/home.js");
}

test("fails closed when the POSIX account identity cannot be resolved", async () => {
  const {
    resolveHomeContext,
    SecureStorageAccountResolutionError,
  } = await loadHomeWithFailedUserInfo();
  expect(() =>
    resolveHomeContext(
      { AGENC_HOME: join(root, "home") },
      { platformHome: root, platform: "linux" },
    )
  ).toThrow(SecureStorageAccountResolutionError);
});

test("Windows uses its DPAPI CurrentUser identity without a username lookup", async () => {
  const { resolveHomeContext } = await loadHomeWithFailedUserInfo();
  expect(
    resolveHomeContext(
      { AGENC_HOME: join(root, "windows-home") },
      { platformHome: root, platform: "win32" },
    ).secureStorageAccount,
  ).toBe("current-user");
});
