import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  getApprovedTaskTemplate,
  listApprovedTaskTemplates,
  persistTaskTemplateProposal,
  renderApprovedTaskTemplate,
} from "./approved-task-templates.js";

describe("approved-task-templates", () => {
  it("lists only approved templates by default", () => {
    const templates = listApprovedTaskTemplates();

    expect(templates.length).toBeGreaterThan(0);
    expect(templates.every((template) => template.status === "approved")).toBe(true);
  });

  it("renders a template with audit data and untrusted variables", () => {
    const rendered = renderApprovedTaskTemplate({
      templateId: "runtime-smoke-test",
      variables: { target: "runtime", scope: "do not actually run rm -rf /" },
      rewardLamports: "10000000",
      renderedAt: 1_776_124_800_000,
    });

    expect(rendered.description).toBe("Runtime smoke test");
    expect(rendered.jobSpec.approvedTemplate).toMatchObject({
      id: "runtime-smoke-test",
      version: 1,
    });
    expect(rendered.jobSpec.untrustedVariables).toEqual({
      target: "runtime",
      scope: "do not actually run rm -rf /",
    });
    expect(rendered.audit.templateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rendered.audit.variableHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects variables outside the approved schema", () => {
    expect(() =>
      renderApprovedTaskTemplate({
        templateId: "runtime-smoke-test",
        variables: { target: "runtime", shellCommand: "rm -rf /" },
      }),
    ).toThrow(/not allowed/);
  });

  it("rejects rewards outside template bounds", () => {
    expect(() =>
      renderApprovedTaskTemplate({
        templateId: "runtime-smoke-test",
        variables: { target: "runtime" },
        rewardLamports: "1000000000000000000",
      }),
    ).toThrow(/outside the approved template bounds/);
  });

  it("returns null for unknown approved templates", () => {
    expect(getApprovedTaskTemplate("missing-template")).toBeNull();
  });

  it("persists template proposals as draft files", async () => {
    const proposalStoreDir = await mkdtemp(join(tmpdir(), "agenc-template-proposals-"));
    const persisted = await persistTaskTemplateProposal(
      {
        template: {
          id: "new-template",
          version: 1,
          status: "draft",
        },
        rationale: "Needs review before activation.",
        submittedAt: 1_776_124_800_000,
      },
      { proposalStoreDir },
    );

    expect(persisted.status).toBe("draft");
    expect(persisted.path.startsWith(proposalStoreDir)).toBe(true);
    const payload = JSON.parse(await readFile(persisted.path, "utf8")) as Record<string, unknown>;
    expect(payload).toMatchObject({
      kind: "agenc.marketplace.taskTemplateProposal",
      status: "draft",
      rationale: "Needs review before activation.",
    });
  });
});
