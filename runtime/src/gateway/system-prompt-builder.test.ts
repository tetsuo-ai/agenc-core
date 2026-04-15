import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { buildBaseSystemPrompt } from "./system-prompt-builder.js";
import type { GatewayConfig } from "./types.js";
import type { Logger } from "../utils/logger.js";

describe("buildBaseSystemPrompt", () => {
  it("includes the independent verifier rule in the main execution protocol", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "agenc-prompt-"));
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    try {
      const prompt = await buildBaseSystemPrompt(
        {
          workspace: { hostPath: workspaceRoot },
        } as GatewayConfig,
        {
          yolo: false,
          configPath: join(workspaceRoot, "config.json"),
          logger: logger as Logger,
        },
      );

      expect(prompt).toContain(
        "do not self-certify completion. Wait for independent verifier confirmation before claiming the implementation is done.",
      );
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
