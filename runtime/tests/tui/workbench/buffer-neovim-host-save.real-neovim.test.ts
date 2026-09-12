import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  discoverNeovim,
  type NeovimDiscoveryResult,
} from "../../../src/tui/workbench/buffer/neovim/NeovimDiscovery.js";
import {
  startEmbeddedNeovim,
  type EmbeddedNeovimSession,
} from "../../../src/tui/workbench/buffer/neovim/NeovimLifecycle.js";
import { cleanupTrackedNeovimProcesses } from "../../../src/tui/workbench/buffer/neovim/NeovimProcess.js";
import { NeovimBufferProvider } from "../../../src/tui/workbench/buffer/providers/neovim/NeovimBufferProvider.js";
import { retryTimedOutEmbeddedNeovimStartup } from "../../helpers/neovim-startup-retry.js";

let dir: string;
let neovim: Extract<NeovimDiscoveryResult, { readonly usable: true }>;

beforeAll(async () => {
  const discovery = await discoverNeovim({
    executable: "nvim",
    useUserInit: false,
  });
  if (!discovery.usable) {
    throw new Error(`real Neovim is required: ${discovery.reason}`);
  }
  neovim = discovery;
}, 45_000);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agenc-real-nvim-host-save-"));
});

afterEach(async () => {
  cleanupTrackedNeovimProcesses("SIGKILL");
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function openHostBuffer() {
  const filePath = join(dir, "target.txt");
  await writeFile(filePath, "original\n");
  let session: EmbeddedNeovimSession | undefined;
  const provider = new NeovimBufferProvider({
    discovery: neovim,
    workspaceRoot: dir,
    startSession: async (options) => {
      session = await retryTimedOutEmbeddedNeovimStartup(
        { ...options, startupTimeoutMs: 60_000 },
        startEmbeddedNeovim,
      );
      return session;
    },
  });
  await provider.open({ filePath });
  expect(provider.getSnapshot().providerStatus).toBe("ready");
  if (!session) throw new Error("the host did not open its Neovim session");
  return { filePath, provider, session };
}

async function inspectActiveBuffer(session: EmbeddedNeovimSession) {
  const manifest = await session.inspectBuffers();
  const active = manifest.buffers.find(
    (buffer) => buffer.handle === manifest.activeBufferHandle,
  );
  if (!active || active.changedtick === null) {
    throw new Error("Neovim did not report an active buffer with a changedtick");
  }
  return { handle: active.handle, changedtick: active.changedtick };
}

describe("real Neovim host save", () => {
  it.each([false, true])(
    "writes through the host without a changedtick (force=%s)",
    async (force) => {
      const { filePath, provider, session } = await openHostBuffer();
      try {
        await session.paste("edited ");
        const { handle } = await inspectActiveBuffer(session);
        const edited = await session.readBufferText(handle);
        expect(edited).toContain("edited ");
        await expect(session.isDirty()).resolves.toBe(true);

        // Ctrl+S and per-buffer saves omit the optional optimistic counter. A
        // MessagePack null becomes vim.NIL, which must not become a false guard.
        await expect(provider.save({ force })).resolves.toBe(true);
        await expect(readFile(filePath, "utf8")).resolves.toBe(edited);
        await expect(session.isDirty()).resolves.toBe(false);
        expect(provider.getSnapshot()).toMatchObject({
          providerStatus: "ready",
          error: null,
          dirty: false,
        });
      } finally {
        await provider.cleanup();
      }
    },
    150_000,
  );

  it("keeps explicit changedtick guards and rejects stale writes without changing disk", async () => {
    const { filePath, provider, session } = await openHostBuffer();
    try {
      await session.paste("first ");
      const buffer = await inspectActiveBuffer(session);
      const first = await session.readBufferText(buffer.handle);
      await expect(
        session.saveBuffer(buffer.handle, false, buffer.changedtick),
      ).resolves.toBe(true);
      await expect(readFile(filePath, "utf8")).resolves.toBe(first);

      await session.paste("second ");
      await expect(
        session.saveBuffer(buffer.handle, true, buffer.changedtick),
      ).rejects.toThrow("buffer changed before write");
      await expect(readFile(filePath, "utf8")).resolves.toBe(first);
      await expect(session.isDirty()).resolves.toBe(true);
      const current = await inspectActiveBuffer(session);
      const second = await session.readBufferText(buffer.handle);
      await expect(
        session.saveBuffer(buffer.handle, true, current.changedtick),
      ).resolves.toBe(true);
      await expect(readFile(filePath, "utf8")).resolves.toBe(second);
    } finally {
      await provider.cleanup();
    }
  }, 150_000);
});
