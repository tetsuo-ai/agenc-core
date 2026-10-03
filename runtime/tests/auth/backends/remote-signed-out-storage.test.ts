import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const readRemoteBearerCredential = vi.hoisted(() => vi.fn());

vi.mock("../native-credentials.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../native-credentials.js")>();
  readRemoteBearerCredential.mockImplementation(actual.readRemoteBearerCredential);
  return { ...actual, readRemoteBearerCredential };
});

import { RemoteAuthBackend } from "./remote.js";

describe("RemoteAuthBackend without a signed-in state", () => {
  const homes: string[] = [];

  afterEach(async () => {
    readRemoteBearerCredential.mockClear();
    await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
  });

  it("reports signed out without reading secure storage", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-remote-signed-out-"));
    homes.push(agencHome);
    const accountSnapshotResolver = vi.fn();
    const backend = new RemoteAuthBackend({ accountSnapshotResolver, agencHome });

    await expect(backend.whoami()).resolves.toEqual({
      authenticated: false,
      provider: "remote",
    });
    expect(readRemoteBearerCredential).not.toHaveBeenCalled();
    expect(accountSnapshotResolver).not.toHaveBeenCalled();
  });
});
