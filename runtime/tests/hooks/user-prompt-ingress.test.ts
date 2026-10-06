import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { defaultConfig } from "../../src/config/schema.js";
import { prepareUserPromptForTurn } from "../../src/hooks/user-prompt-ingress.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import {
  canonicalizePath,
  clearSessionReadState,
  getSessionReadSnapshot,
} from "../../src/tools/system/filesystem.js";

function promptSession(
  cwd: string,
  hooks: Array<(input: { readonly prompt: string }) => unknown>,
  simpleMode = false,
  skillsForConfig?: (...args: unknown[]) => unknown,
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
      runtimeOptions: resolveAgentRuntimeOptions({}, { simpleMode }),
      ...(skillsForConfig !== undefined
        ? { skillsManager: { skillsForConfig } }
        : {}),
    },
    sessionConfiguration: { cwd },
  };
  return { session, events };
}

/** Paths of every `file_mention_attachment_dropped` warning, in emit order. */
function droppedMentionPaths(events: readonly unknown[]): string[] {
  const paths: string[] = [];
  for (const event of events) {
    const msg = (event as {
      msg?: { type?: string; payload?: { cause?: string; path?: string } };
    }).msg;
    if (
      msg?.type === "warning" &&
      msg.payload?.cause === "file_mention_attachment_dropped"
    ) {
      paths.push(msg.payload.path ?? "");
    }
  }
  return paths;
}

/** A `skillsForConfig` mock shaped like the local loader's outcome. */
function skillsForConfigWith(
  skills: ReadonlyArray<{
    readonly name: string;
    readonly aliases?: readonly string[];
    readonly pluginId?: string;
  }>,
) {
  return vi.fn(async () => ({
    invokedSkills: [],
    availableSkills: skills.map((skill) => ({
      ...skill,
      path: `/skills/${skill.name}/SKILL.md`,
      root: "/skills",
      scope: "plugin",
    })),
  }));
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
      clearSessionReadState(session.conversationId, tmpdir());
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
      expect(events).toContainEqual(
        expect.objectContaining({
          msg: expect.objectContaining({
            type: "warning",
            payload: expect.objectContaining({
              cause: "user_prompt_submit_hook_blocked",
              message: expect.stringContaining("policy denied"),
            }),
          }),
        }),
      );
    } finally {
      clearSessionReadState(session.conversationId, tmpdir());
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns neutral prompt ingress without invoking hooks in owner simple mode", async () => {
    const hook = vi.fn(() => ({
      blockingError: { blockingError: "must not block" },
      additionalContexts: ["must not append"],
    }));
    const { session, events } = promptSession("/workspace", [hook], true);

    const result = await prepareUserPromptForTurn({
      session: session as never,
      input: "unchanged prompt",
    });

    expect(hook).not.toHaveBeenCalled();
    expect(result).toEqual({
      blocked: false,
      input: "unchanged prompt",
      displayInput: "unchanged prompt",
    });
    expect(events).toEqual([]);
  });
});

describe("plugin and skill mentions in prompt ingress", () => {
  it("does not warn for a bare mention that names an installed plugin, missing or a directory", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agenc-prompt-plugin-"));
    // A plugin checked out under its own name in cwd is the usual layout
    // while developing it; a directory is still not an attachable file.
    await mkdir(join(cwd, "motor3d"));
    const skillsForConfig = skillsForConfigWith([
      { name: "motor3d-build", pluginId: "motor3d" },
      { name: "roarm-drive", pluginId: "RoArm" },
    ]);
    const { session, events } = promptSession(cwd, [], false, skillsForConfig);
    const input = "use @motor3d then @roarm to move the part";

    try {
      const result = await prepareUserPromptForTurn({
        session: session as never,
        configStore: { current: () => defaultConfig },
        input,
      });

      expect(result).toEqual({ blocked: false, input, displayInput: input });
      expect(droppedMentionPaths(events)).toEqual([]);
      // Same call and config snapshot run-turn.ts hands the skill listing
      // that feeds rankSkillsForRequest, so the lookup shares its cache.
      expect(skillsForConfig).toHaveBeenCalledTimes(1);
      expect(skillsForConfig).toHaveBeenCalledWith(defaultConfig, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not warn for a bare mention that names a loaded skill or one of its aliases", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agenc-prompt-skill-"));
    const skillsForConfig = skillsForConfigWith([
      { name: "motor3d" },
      { name: ".hidden:reflect", aliases: ["reflect"] },
    ]);
    const { session, events } = promptSession(cwd, [], false, skillsForConfig);
    const input = [
      { type: "image_url" as const, image_url: { url: "data:image/png;base64,AA==" } },
      { type: "text" as const, text: "run @motor3d" },
      { type: "text" as const, text: "then @reflect on the result" },
    ];

    try {
      const result = await prepareUserPromptForTurn({
        session: session as never,
        configStore: { current: () => defaultConfig },
        input,
      });

      expect(result.blocked).toBe(false);
      expect(result.input).toEqual(input);
      expect(droppedMentionPaths(events)).toEqual([]);
      // One lookup per prepared prompt, shared by every text part.
      expect(skillsForConfig).toHaveBeenCalledTimes(1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("still attaches a readable file named like a plugin and never loads the skills for it", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agenc-prompt-file-wins-"));
    await writeFile(join(cwd, "motor3d"), "gcode header\n", "utf8");
    const skillsForConfig = skillsForConfigWith([
      { name: "motor3d-build", pluginId: "motor3d" },
    ]);
    const { session, events } = promptSession(cwd, [], false, skillsForConfig);

    try {
      const result = await prepareUserPromptForTurn({
        session: session as never,
        configStore: { current: () => defaultConfig },
        input: "read @motor3d",
      });

      expect(result.blocked).toBe(false);
      expect(JSON.stringify(result.input)).toContain("gcode header");
      expect(droppedMentionPaths(events)).toEqual([]);
      // The file won, so no bare mention failed and nothing was looked up.
      expect(skillsForConfig).not.toHaveBeenCalled();
    } finally {
      clearSessionReadState(session.conversationId, tmpdir());
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("keeps the warning for unknown bare tokens and for path or dotted mentions", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agenc-prompt-unknown-"));
    const skillsForConfig = skillsForConfigWith([
      { name: "motor3d-build", pluginId: "motor3d" },
    ]);
    const { session, events } = promptSession(cwd, [], false, skillsForConfig);

    try {
      const result = await prepareUserPromptForTurn({
        session: session as never,
        configStore: { current: () => defaultConfig },
        input: "see @nothere, @motor3d.md and @src/motor3d",
      });

      expect(result.blocked).toBe(false);
      // A dot or a separator makes it a file path even when the stem is a
      // plugin id; an unknown bare token is still a broken mention.
      expect(droppedMentionPaths(events)).toEqual([
        "nothere",
        "motor3d.md",
        "src/motor3d",
      ]);
      expect(skillsForConfig).toHaveBeenCalledTimes(1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("falls back to the file warning when the skill lookup fails or is absent", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agenc-prompt-lookup-fail-"));
    const failing = promptSession(cwd, [], false, () =>
      Promise.reject(new Error("skills unavailable")),
    );
    const absent = promptSession(cwd, []);

    try {
      for (const { session, events } of [failing, absent]) {
        const result = await prepareUserPromptForTurn({
          session: session as never,
          configStore: { current: () => defaultConfig },
          input: "use @motor3d",
        });

        expect(result.blocked).toBe(false);
        expect(result.input).toBe("use @motor3d");
        expect(droppedMentionPaths(events)).toEqual(["motor3d"]);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
