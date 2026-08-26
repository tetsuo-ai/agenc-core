import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { defaultConfig } from "../../src/config/schema.js";
import { prepareUserPromptForTurn } from "../../src/hooks/user-prompt-ingress.js";
import {
  canonicalizePath,
  clearSessionReadState,
  getSessionReadSnapshot,
} from "../../src/tools/system/filesystem.js";

function promptSession(
  cwd: string,
  hooks: Array<(input: { readonly prompt: string }) => unknown>,
) {
  const events: unknown[] = [];
  const session = {
    abortController: new AbortController(),
    conversationId: "prompt-ingress-session",
    emit: (event: unknown) => events.push(event),
    nextInternalSubId: () => `prompt-ingress-${events.length + 1}`,
    permissionModeRegistry: {
      current: () => ({ mode: "default" }),
    },
    services: {
      hooks: { userPromptSubmitHooks: hooks },
    },
    sessionConfiguration: { cwd },
  };
  return { session, events };
}

describe("canonical user prompt ingress", () => {
  it("runs the owning-session hook once on raw text before expanding multimodal file mentions", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agenc-prompt-ingress-"));
    const notePath = join(cwd, "note.txt");
    await writeFile(notePath, "daemon-owned file body\n", "utf8");
    const canonicalNotePath = await canonicalizePath(notePath);
    const prompts: string[] = [];
    const { session } = promptSession(cwd, [
      (input) => {
        prompts.push(input.prompt);
        return { additionalContexts: ["session-owned context"] };
      },
    ]);

    try {
      const result = await prepareUserPromptForTurn({
        session: session as never,
        configStore: { current: () => defaultConfig },
        hookPrompt: "inspect @note.txt",
        input: [
          { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
          { type: "text", text: "inspect @note.txt" },
        ],
      });

      expect(result.blocked).toBe(false);
      expect(prompts).toEqual(["inspect @note.txt"]);
      const modelInput = JSON.stringify(result.input);
      expect(modelInput).toContain("daemon-owned file body");
      expect(modelInput).toContain("# Hook Additional Context");
      expect(modelInput).toContain("session-owned context");
      expect(
        getSessionReadSnapshot(session.conversationId, canonicalNotePath)
          ?.rawContent,
      ).toBe("daemon-owned file body\n");
    } finally {
      clearSessionReadState(session.conversationId);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not read or expand file mentions after a hook blocks ingress", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agenc-prompt-block-"));
    const notePath = join(cwd, "secret.txt");
    await writeFile(notePath, "must not be read\n", "utf8");
    const canonicalNotePath = await canonicalizePath(notePath);
    const { session, events } = promptSession(cwd, [
      () => ({ blockingError: { blockingError: "policy denied" } }),
    ]);

    try {
      const result = await prepareUserPromptForTurn({
        session: session as never,
        configStore: { current: () => defaultConfig },
        input: "inspect @secret.txt",
      });

      expect(result).toMatchObject({
        blocked: true,
        input: "inspect @secret.txt",
        blockMessage: expect.stringContaining("policy denied"),
      });
      expect(
        getSessionReadSnapshot(session.conversationId, canonicalNotePath),
      ).toBeUndefined();
      expect(JSON.stringify(events)).toContain(
        "user_prompt_submit_hook_blocked",
      );
    } finally {
      clearSessionReadState(session.conversationId);
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
