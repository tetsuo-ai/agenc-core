import { describe, expect, it } from "vitest";
import { formFields, validationFor } from "../../src/commands/agents-menu.js";
const form = {
  source: "projectSettings" as const,
  agentType: "private-role",
  whenToUse: "A private test role for validation",
  tools: "*",
  model: "deepseek-flash",
  systemPrompt: "Reply with the requested result only.",
};
describe("agent editor model policy", () => {
  it("shows enforced inheritance and prevents project overrides in create and edit", () => {
    for (const mode of ["create", "edit"] as const) {
      expect(formFields(form, mode).find(field => field.key === "model")).toMatchObject({
        value: "inherit", editable: false, detail: expect.stringContaining("Project roles inherit"),
      });
      expect(validationFor(form, [], [] as any, mode).errors).toContain("Project roles inherit the session model. Use a user role for a model override.");
    }
  });
  it("keeps user model overrides editable and allows project inheritance", () => {
    const user = { ...form, source: "userSettings" as const };
    expect(formFields(user, "edit").find(field => field.key === "model")).toMatchObject({ value: "deepseek-flash", editable: true });
    expect(validationFor(user, [], [] as any, "edit").errors).toEqual([]);
    expect(validationFor({ ...form, model: "" }, [], [] as any, "edit").errors).toEqual([]);
  });
});
