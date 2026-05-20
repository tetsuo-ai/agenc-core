import React from "react";
import { describe, expect, test, vi } from "vitest";

import { renderToString } from "../../utils/staticRender.js";
import { AttachmentMessage } from "./AttachmentMessage.js";

const featureMock = vi.hoisted(() => ({
  experimentalSkillSearch: false,
}));

vi.mock("bun:bundle", () => ({
  feature: (flag: string) =>
    flag === "EXPERIMENTAL_SKILL_SEARCH" &&
    featureMock.experimentalSkillSearch,
}));

vi.mock("../../utils/agentSwarmsEnabled.js", () => ({
  isAgentSwarmsEnabled: () => false,
}));

async function renderAttachment(attachment: unknown): Promise<string> {
  return renderToString(
    <AttachmentMessage
      addMargin={false}
      attachment={attachment as never}
      verbose={false}
    />,
    { columns: 120 },
  );
}

describe("AttachmentMessage coverage", () => {
  test("renders feature-gated skill discovery summaries and hides empty results", async () => {
    featureMock.experimentalSkillSearch = true;

    await expect(
      renderAttachment({
        signal: "project_context",
        skills: [
          {
            description: "Creates compact implementation plans",
            name: "Plan Builder",
            shortId: "pb1",
          },
          {
            description: "Reviews focused diffs",
            name: "Diff Reviewer",
          },
        ],
        source: "native",
        type: "skill_discovery",
      }),
    ).resolves.toContain(
      "2 relevant skills: Plan Builder [pb1], Diff Reviewer",
    );

    const emptyOutput = await renderAttachment({
      signal: "project_context",
      skills: [],
      source: "native",
      type: "skill_discovery",
    });
    expect(emptyOutput.trim()).toBe("");
  });
});
