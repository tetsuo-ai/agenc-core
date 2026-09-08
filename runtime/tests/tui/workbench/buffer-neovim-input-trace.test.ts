import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  NeovimInputTrace,
  neovimInputTraceForTesting,
  type NeovimInputTraceRecord,
} from "../../../src/tui/workbench/buffer/neovim/NeovimInputTrace.js";
import {
  enableNeovimInputTrace,
  readNeovimInputTrace,
} from "../../../scripts/check-tui-e2e/helpers/workbench-buffer-neovim.mjs";

describe("Neovim test input trace", () => {
  it("is disabled without an explicit test trace path", () => {
    expect(neovimInputTraceForTesting({})).toBeNull();
  });

  it("keeps sequences monotonic across owners and snapshots RPC completion", () => {
    const records: NeovimInputTraceRecord[] = [];
    const trace = new NeovimInputTrace((record) => records.push(record));
    const first = trace.begin("first", "escape");
    trace.progress(first, "running");
    trace.progress(first, "rpc-complete");
    trace.progress(first, "mode", "i");
    trace.progress(first, "complete", "n");
    const second = trace.begin("second", "colon");
    expect(second.sequence).toBe(first.sequence + 1);
    expect(records[0]).toMatchObject({ rpcCompleted: false, phase: "queued" });
    expect(records[1]).toMatchObject({ pendingRpc: "input" });
    expect(records[2]).toMatchObject({ rpcCompleted: true, pendingRpc: "mode" });
    expect(records[3]).toMatchObject({ mode: "i", pendingRpc: "mode" });
    expect(records[4]).toMatchObject({ mode: "n", pendingRpc: null });
  });

  it("writes a private trace without input text and ignores unfinished records", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agenc-neovim-trace-"));
    try {
      const session = {
        cwd,
        envOverrides: {} as NodeJS.ProcessEnv,
        neovimInputTracePath: "",
      };
      enableNeovimInputTrace(session);
      expect(await readNeovimInputTrace(session)).toEqual([]);
      const trace = neovimInputTraceForTesting(session.envOverrides)!;
      const state = {
        sessionId: "owned", focusOwner: "buffer",
        providerStatus: "ready", providerMode: "normal",
      } as const;
      trace.state(state);
      trace.state(state);
      const token = trace.begin("owned", "paste");
      trace.progress(token, "rpc-complete");
      trace.progress(token, "complete", "c");
      const records = await readNeovimInputTrace(session);
      expect(records).toHaveLength(4);
      expect(records.at(-1)).toMatchObject({
        sequence: 1, mode: "c", rpcCompleted: true,
      });
      const text = await readFile(session.neovimInputTracePath, "utf8");
      expect(text).not.toContain('"text"');
      expect(text).not.toContain('"keys"');
      if (process.platform !== "win32") {
        expect((await stat(session.neovimInputTracePath)).mode & 0o777).toBe(0o600);
      }
      await writeFile(session.neovimInputTracePath, `${text}{"type":`);
      expect(await readNeovimInputTrace(session)).toEqual(records);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not throw into provider input when a test trace cannot be written", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agenc-neovim-trace-failure-"));
    try {
      const trace = neovimInputTraceForTesting({ AGENC_TEST_NEOVIM_INPUT_TRACE: cwd })!;
      expect(() => trace.begin("owned", "escape")).not.toThrow();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
