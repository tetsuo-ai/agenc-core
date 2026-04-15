import { describe, expect, it } from "vitest";
import {
  checkToolCallPermission,
  didToolCallFail,
  extractToolFailureTextFromResult,
  normalizeToolCallArguments,
  repairToolCallArgumentsFromMessageText,
  summarizeToolArgumentChanges,
} from "./chat-executor-tool-utils.js";

describe("chat-executor-tool-utils", () => {
  describe("didToolCallFail", () => {
    it("returns true when execution is marked isError", () => {
      expect(didToolCallFail(true, "ok")).toBe(true);
    });

    it("returns true for JSON error payloads", () => {
      expect(didToolCallFail(false, '{"error":"boom"}')).toBe(true);
    });

    it("returns true for nested JSON error payloads", () => {
      expect(
        didToolCallFail(
          false,
          JSON.stringify({
            error: {
              code: "browser_session.domain_blocked",
              message: "SSRF target blocked: localhost",
            },
          }),
        ),
      ).toBe(true);
    });

    it("returns true for non-zero JSON exitCode", () => {
      expect(didToolCallFail(false, '{"exitCode":1}')).toBe(true);
    });

    it("returns true for JSON timeout payloads", () => {
      expect(didToolCallFail(false, '{"timedOut":true,"exitCode":null}')).toBe(true);
    });

    it("returns true when shell stderr reports a path/cwd failure despite exitCode 0", () => {
      expect(
        didToolCallFail(
          false,
          JSON.stringify({
            stdout: "Running tests...\nCompilation test passed\n",
            stderr:
              "run_tests.sh: line 6: cd: build: No such file or directory\n",
            exitCode: 0,
          }),
        ),
      ).toBe(true);
    });

    it("returns true for weak verification passes with no executed tests", () => {
      expect(
        didToolCallFail(
          false,
          JSON.stringify({
            exitCode: 0,
            stdout: "Internal ctest changing into directory: /workspace/build",
            stderr: "No tests were found!!!",
            __agencVerification: {
              probeId: "generic:test:ctest",
              category: "test",
              profile: "generic",
              command: "ctest --test-dir build --output-on-failure",
            },
          }),
        ),
      ).toBe(true);
    });

    it("returns true for MCP plain-text failure signatures", () => {
      expect(
        didToolCallFail(
          false,
          'MCP tool "launch" failed: MCP tool "launch" callTool timed out after 30000ms',
        ),
      ).toBe(true);
    });

    it("returns true for plain-text tool execution errors", () => {
      expect(
        didToolCallFail(
          false,
          "Error executing tool send_text: Instance 'terminal1' not found",
        ),
      ).toBe(true);
    });

    it("returns true for plain-text tool-not-found failures", () => {
      expect(didToolCallFail(false, 'Tool not found: "desktop.bash"')).toBe(true);
    });

    it("returns true for desktop-session requirement failures", () => {
      expect(
        didToolCallFail(false, "Container MCP tool — requires desktop session"),
      ).toBe(true);
    });

    it("returns false for normal non-JSON output", () => {
      expect(didToolCallFail(false, "all good")).toBe(false);
    });
  });

  describe("extractToolFailureTextFromResult", () => {
    it("preserves both stderr and stdout when a failing tool writes diagnostics to stdout", () => {
      expect(
        extractToolFailureTextFromResult(
          JSON.stringify({
            exitCode: 2,
            stdout:
              "error TS6059: File '/workspace/packages/web/vite.config.ts' is not under 'rootDir' '/workspace/packages/web/src'.",
            stderr: "Command failed: npx tsc --build",
          }),
        ),
      ).toContain("TS6059");
    });

    it("extracts nested error diagnostics from structured tool results", () => {
      const text = extractToolFailureTextFromResult(
        JSON.stringify({
          error: {
            family: "browser_session",
            code: "browser_session.domain_blocked",
            message: "SSRF target blocked: localhost",
          },
        }),
      );

      expect(text).toContain("SSRF target blocked: localhost");
      expect(text).toContain("browser_session.domain_blocked");
      expect(text).toContain("browser_session");
    });
  });

  describe("normalizeToolCallArguments", () => {
    it("canonicalizes aliased filesystem argument names before execution", () => {
      expect(
        normalizeToolCallArguments("system.readFile", {
          filePath: "/workspace/PLAN.md",
        }),
      ).toEqual({
        path: "/workspace/PLAN.md",
      });
      expect(
        normalizeToolCallArguments("system.writeFile", {
          filePath: "/workspace/PLAN.md",
          text: "updated",
        }),
      ).toEqual({
        path: "/workspace/PLAN.md",
        content: "updated",
      });
    });

    it("decodes over-escaped multiline write content before execution", () => {
      expect(
        normalizeToolCallArguments("system.writeFile", {
          path: "/workspace/main.c",
          content: '#include "shell.h"\\nint main(void) { return 0; }\\n',
        }),
      ).toEqual({
        path: "/workspace/main.c",
        content: '#include "shell.h"\nint main(void) { return 0; }\n',
      });
    });

    it("decodes over-escaped edit strings without touching legitimate in-code escapes", () => {
      expect(
        normalizeToolCallArguments("system.editFile", {
          path: "/workspace/main.c",
          old_string: 'printf(\\"hi\\\\n\\");\\nreturn 0;',
          new_string: 'printf(\\"hello\\\\n\\");\\nreturn 0;',
        }),
      ).toEqual({
        path: "/workspace/main.c",
        old_string: 'printf("hi\\n");\nreturn 0;',
        new_string: 'printf("hello\\n");\nreturn 0;',
      });
    });

    it("decodes over-escaped bash commands before execution", () => {
      expect(
        normalizeToolCallArguments("system.bash", {
          command: 'echo \\"hello\\" && printf \\"%s\\\\n\\" ok',
        }),
      ).toEqual({
        command: 'echo "hello" && printf "%s\\n" ok',
      });
    });
  });

  describe("repairToolCallArgumentsFromMessageText", () => {
    it("repairs collaboration args from explicit field labels in the prompt", () => {
      const repaired = repairToolCallArgumentsFromMessageText(
        "social.requestCollaboration",
        {
          requiredCapabilities: "3",
          maxMembers: 3,
          payoutMode: "fixed",
        },
        "Use social.requestCollaboration with title Launch Ritual Drill, description Need 3 agents to simulate a privacy-safe localnet launch with one observer and two operators., requiredCapabilities 3, maxMembers 3, payoutMode fixed. After the tool calls finish, reply with exactly R6_DONE_A2.",
      );

      expect(repaired.args).toEqual({
        title: "Launch Ritual Drill",
        description:
          "Need 3 agents to simulate a privacy-safe localnet launch with one observer and two operators.",
        requiredCapabilities: "3",
        maxMembers: 3,
        payoutMode: "fixed",
      });
      expect(repaired.repairedFields).toEqual(["title", "description"]);
    });

    it("does not overwrite collaboration fields that were already present", () => {
      const repaired = repairToolCallArgumentsFromMessageText(
        "social.requestCollaboration",
        {
          title: "Existing Title",
          description: "Existing description",
          requiredCapabilities: "3",
          maxMembers: 3,
          payoutMode: "fixed",
        },
        "Use social.requestCollaboration with title Launch Ritual Drill, description Different description, requiredCapabilities 3, maxMembers 3, payoutMode fixed.",
      );

      expect(repaired.args.title).toBe("Existing Title");
      expect(repaired.args.description).toBe("Existing description");
      expect(repaired.repairedFields).toEqual([]);
    });

    it("does not repair raw agenc.createTask arguments", () => {
      const repaired = repairToolCallArgumentsFromMessageText(
        "agenc.createTask",
        {
          description: "self test parser omitted task id after restart",
          reward: "10000000",
          requiredCapabilities: "1",
          taskId: '{"description":"self',
          constraintHash: '{"description":"self',
          validationMode: "auto",
        },
        "Call agenc.createTask with exactly this JSON. Do not add taskId or constraintHash:\n" +
          '{"description":"self test parser omitted task id after restart","reward":"10000000","requiredCapabilities":"1","validationMode":"auto"}',
      );

      expect(repaired.args).toEqual({
        description: "self test parser omitted task id after restart",
        reward: "10000000",
        requiredCapabilities: "1",
        taskId: '{"description":"self',
        constraintHash: '{"description":"self',
        validationMode: "auto",
      });
      expect(repaired.repairedFields).toEqual([]);
    });

    it("leaves human-friendly agenc.createTask arguments invalid", () => {
      const repaired = repairToolCallArgumentsFromMessageText(
        "agenc.createTask",
        {
          fullDescription: "Write one fun fact about Solana devnet.",
          reward: "0.01",
          requiredCapabilities: '["INFERENCE"]',
          taskId: "random-tech-fact-001",
          rewardMint: "So11111111111111111111111111111111111111112",
        },
        "create a random task",
      );

      expect(repaired.args).toEqual({
        fullDescription: "Write one fun fact about Solana devnet.",
        reward: "0.01",
        requiredCapabilities: '["INFERENCE"]',
        taskId: "random-tech-fact-001",
        rewardMint: "So11111111111111111111111111111111111111112",
      });
      expect(repaired.repairedFields).toEqual([]);
    });

    it("does not fall back to COMPUTE for tag-like agenc.createTask capabilities", () => {
      const repaired = repairToolCallArgumentsFromMessageText(
        "agenc.createTask",
        {
          description: "Random joke task",
          reward: "1 SOL",
          requiredCapabilities: "meme, relationship, humor",
        },
        "create a random task",
      );

      expect(repaired.args).toEqual({
        description: "Random joke task",
        reward: "1 SOL",
        requiredCapabilities: "meme, relationship, humor",
      });
      expect(repaired.repairedFields).toEqual([]);
    });
  });

  describe("summarizeToolArgumentChanges", () => {
    it("returns changed argument fields between raw and normalized args", () => {
      expect(
        summarizeToolArgumentChanges(
          { screen_resolution: "1280x720", recording_path: "null" },
          {
            screen_resolution: "RES_1280X720",
            window_visible: true,
            render_hud: true,
          },
        ),
      ).toEqual([
        "recording_path",
        "render_hud",
        "screen_resolution",
        "window_visible",
      ]);
    });
  });

  describe("checkToolCallPermission", () => {
    it("does not block repeated side-effect tools within the same round", () => {
      const permission = checkToolCallPermission(
        {
          id: "tool-1",
          name: "system.open",
          arguments: "{}",
        },
        null,
        null,
        false,
        false,
      );

      expect(permission).toEqual({ action: "processed" });
    });

    it("still blocks tools outside the routed subset", () => {
      const permission = checkToolCallPermission(
        {
          id: "tool-2",
          name: "system.delete",
          arguments: "{}",
        },
        null,
        new Set(["system.readFile"]),
        true,
        false,
      );

      expect(permission.action).toBe("skip");
      expect(permission.routingMiss).toBe(true);
      expect(permission.expandAfterRound).toBe(true);
    });
  });
});
