import { describe, expect, it } from "vitest";

import { findCommand, type Command } from "./commands.js";

describe("findCommand", () => {
  it("prefers exact command names before aliases", () => {
    const exact = {
      type: "prompt",
      name: "imagegen",
      description: "project skill",
    } as Command;
    const alias = {
      type: "prompt",
      name: ".system:imagegen",
      aliases: ["imagegen"],
      description: "system skill",
    } as Command;

    expect(findCommand("imagegen", [alias, exact])).toBe(exact);
    expect(findCommand(".system:imagegen", [alias, exact])).toBe(alias);
  });
});
