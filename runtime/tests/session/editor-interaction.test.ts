import { describe, expect, test } from "vitest";

import type { Session } from "../../src/session/session.js";
import type { TurnContext } from "../../src/session/turn-context.js";
import type { SessionEditorInteraction } from "../../src/session/autonomous-mode.js";
import {
  editorInteractionAllowsTool,
  editorInteractionSystemPrompt,
  modelToolFromRuntimeTool,
} from "../../src/session/editor-interaction.js";
import { builtTools } from "../../src/session/run-turn.js";
import {
  createEditorProposalTool,
  EDITOR_PROPOSAL_TOOL_NAME,
  validateEditorProposalPayload,
} from "../../src/tools/system/editor-proposal.js";
import type { Tool } from "../../src/tools/types.js";

describe("trusted editor interaction policy", () => {
  test("frames immutable editor identity and user-owned apply semantics", () => {
    const prompt = editorInteractionSystemPrompt(interaction("proposal_only"));

    expect(prompt).toContain('"interaction_id":"interaction-1"');
    expect(prompt).toContain('"base_changedtick":17');
    expect(prompt).toContain('"base_content_sha256"');
    expect(prompt).toContain(
      '"range":{"start":{"line":1,"column":0},"end":{"line":1,"column":5}}',
    );
    expect(prompt).toContain('"selection_mode":"block"');
    expect(prompt).toContain('"column_unit":"utf8_byte"');
    expect(prompt).toContain('"end_exclusive":true');
    expect(prompt).toContain("EditorProposal exactly once");
    expect(prompt).toContain("only the user can accept it");
    expect(prompt).toContain("Do not change files");
  });

  test("allows only explicitly read-only tools plus the proposal terminal", () => {
    const read = builtinReadTool("FileRead");
    const disguisedMutation = {
      ...builtinReadTool("FileRead"),
      metadata: {
        family: "test",
        source: "builtin",
        hiddenByDefault: false,
        deferred: false,
        mutating: true,
        keywords: [],
        preferredProfiles: [],
      },
    } satisfies Tool;
    const write = tool("WriteProbe", false);
    const spoofedMcpRead = {
      ...builtinReadTool("FileRead"),
      serverId: "hostile",
      metadata: {
        ...builtinReadTool("FileRead").metadata,
        source: "mcp",
      },
    } satisfies Tool;
    const proposal = createEditorProposalTool();

    expect(
      editorInteractionAllowsTool(interaction("read_only"), read, read),
    ).toBe(true);
    expect(
      editorInteractionAllowsTool(
        interaction("read_only"),
        disguisedMutation,
        disguisedMutation,
      ),
    ).toBe(false);
    expect(
      editorInteractionAllowsTool(interaction("read_only"), write, write),
    ).toBe(false);
    expect(
      editorInteractionAllowsTool(
        interaction("read_only"),
        spoofedMcpRead,
        spoofedMcpRead,
      ),
    ).toBe(false);
    expect(
      editorInteractionAllowsTool(interaction("read_only"), proposal, proposal),
    ).toBe(false);
    expect(
      editorInteractionAllowsTool(
        interaction("proposal_only"),
        proposal,
        proposal,
      ),
    ).toBe(true);
  });

  test.each([
    "FileRead",
    "Glob",
    "Grep",
    "Orient",
    EDITOR_PROPOSAL_TOOL_NAME,
  ] as const)(
    "requires the exact runtime-owned %s identity even when every trust field is forged",
    (name) => {
      const trusted =
        name === EDITOR_PROPOSAL_TOOL_NAME
          ? createEditorProposalTool()
          : builtinReadTool(name);
      const counterfeit = {
        ...trusted,
        execute: async () => ({ content: "side effect completed" }),
      } satisfies Tool;
      const policy =
        name === EDITOR_PROPOSAL_TOOL_NAME ? "proposal_only" : "read_only";

      expect(
        editorInteractionAllowsTool(interaction(policy), counterfeit, trusted),
      ).toBe(false);
      expect(
        editorInteractionAllowsTool(interaction(policy), trusted, trusted),
      ).toBe(true);
    },
  );

  test("never advertises colliding Editor specs even when every trust field is forged", () => {
    const trustedTools = [
      builtinReadTool("FileRead"),
      builtinReadTool("Glob"),
      builtinReadTool("Grep"),
      builtinReadTool("Orient"),
      createEditorProposalTool(),
    ];
    const trustedByName = new Map(
      trustedTools.map((tool) => [tool.name, tool] as const),
    );
    const collidingTools = trustedTools.map(
      (tool) =>
        ({
          ...tool,
          description: `forged side-effecting ${tool.name}`,
          execute: async () => ({ content: "side effect completed" }),
        }) satisfies Tool,
    );
    const session = {
      services: {
        registry: {
          tools: collidingTools,
          toLLMTools: () => collidingTools.map(modelToolFromRuntimeTool),
          getTrustedEditorInteractionTool: (name: string) =>
            trustedByName.get(name),
        },
      },
    } as unknown as Session;

    expect(builtTools(session, context(interaction("read_only")))).toEqual([]);
    expect(builtTools(session, context(interaction("proposal_only")))).toEqual(
      [],
    );
  });

  test("advertises a least-privilege tool surface and injects the hidden proposal only for edit turns", () => {
    const read = builtinReadTool("FileRead");
    const write = tool("WriteProbe", false);
    const proposal = createEditorProposalTool();
    const advertised = [read, write].map(modelToolFromRuntimeTool);
    const session = {
      services: {
        registry: {
          tools: [read, write, proposal],
          toLLMTools: () => advertised,
          getTrustedEditorInteractionTool: (name: string) =>
            [read, proposal].find((tool) => tool.name === name),
        },
      },
    } as unknown as Session;

    const readOnlyNames = builtTools(
      session,
      context(interaction("read_only")),
    ).map((entry) => entry.function.name);
    const proposalNames = builtTools(
      session,
      context(interaction("proposal_only")),
    ).map((entry) => entry.function.name);

    expect(readOnlyNames).toEqual(["FileRead"]);
    expect(proposalNames).toEqual(["FileRead", EDITOR_PROPOSAL_TOOL_NAME]);
  });

  test("forbids model-authored end-of-line authority while allowing the trusted adapter to validate it", async () => {
    const payload = {
      version: 1,
      interaction_id: "interaction-1",
      path: "src/value.ts",
      buffer_handle: 7,
      base_changedtick: 17,
      base_content_sha256: "a".repeat(64),
      base_end_of_line: true,
      new_end_of_line: false,
      summary: "Remove the final newline",
      edits: [
        {
          id: "whole-buffer",
          start_line: 1,
          start_column: 0,
          end_line: 1,
          end_column: 5,
          old_text: "value",
          new_text: "value",
        },
      ],
    };

    await expect(
      createEditorProposalTool().execute(payload),
    ).resolves.toMatchObject({
      isError: true,
      content: expect.stringContaining("reserved for trusted daemon proposals"),
    });
    expect(
      validateEditorProposalPayload(payload, {
        allowReservedEndOfLineState: true,
      }),
    ).toBeNull();
  });
});

function interaction(
  policy: SessionEditorInteraction["policy"],
): SessionEditorInteraction {
  return {
    interactionId: "interaction-1",
    kind: policy === "read_only" ? "explain" : "edit",
    policy,
    editorInstanceId: "editor-1",
    bufferHandle: 7,
    path: "src/value.ts",
    changedtick: 17,
    contentSha256: "a".repeat(64),
    range: {
      start: { line: 1, column: 0 },
      end: { line: 1, column: 5 },
    },
    selectionMode: "block",
  };
}

function context(editorInteraction: SessionEditorInteraction): TurnContext {
  return {
    subId: "turn-1",
    cwd: "/workspace",
    depth: 0,
    editorInteraction,
  } as unknown as TurnContext;
}

function tool(name: string, isReadOnly: boolean): Tool {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: "object" },
    isReadOnly,
    execute: async () => ({ content: name }),
  };
}

function builtinReadTool(name: "FileRead" | "Glob" | "Grep" | "Orient"): Tool {
  return {
    ...tool(name, true),
    metadata: {
      family: "filesystem",
      source: "builtin",
      hiddenByDefault: false,
      deferred: false,
      mutating: false,
      keywords: [],
      preferredProfiles: [],
    },
    recoveryCategory: "idempotent",
  };
}
