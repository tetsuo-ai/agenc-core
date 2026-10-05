import { describe, expect, it } from "vitest";

import {
  trustDialogOptionLabel,
  trustItemRows,
  trustLocationWarning,
  trustReviewLead,
  trustSafetyNote,
} from "./TrustDialog.js";

describe("trustDialogOptionLabel", () => {
  it("names the buttons plainly while idle", () => {
    expect(trustDialogOptionLabel("trust", null, false)).toBe("Trust");
    expect(trustDialogOptionLabel("exit", null, false)).toBe("Exit");
    expect(trustDialogOptionLabel("trust", "trust", false)).toBe("Trust");
  });

  it("shows pending copy only on the pressed button", () => {
    expect(trustDialogOptionLabel("trust", "trust", true)).toBe("Trusting...");
    expect(trustDialogOptionLabel("exit", "trust", true)).toBe("Exit");
    expect(trustDialogOptionLabel("exit", "exit", true)).toBe("Exiting...");
    expect(trustDialogOptionLabel("trust", "exit", true)).toBe("Trust");
  });
});

describe("trust card copy", () => {
  const repo = { label: "Hooks", values: ["./audit.sh before each tool"] };
  const user = { label: "Your hooks", values: ["notify.sh when a turn ends"] };

  it("leads with what trust turns on, by who ships it", () => {
    expect(trustReviewLead(undefined)).toBeUndefined();
    expect(trustReviewLead({ repoItems: [], userItems: [] })).toBeUndefined();
    expect(trustReviewLead({ repoItems: [repo], userItems: [] })).toBe(
      "Trusting turns on the AgenC settings this repo ships:",
    );
    expect(trustReviewLead({ repoItems: [], userItems: [user] })).toBe(
      "Trusting lets your own setup run in this folder:",
    );
    expect(trustReviewLead({ repoItems: [repo], userItems: [user] })).toBe(
      "Trusting turns these on in this folder:",
    );
  });

  it("warns about the home folder and the disk root", () => {
    expect(trustLocationWarning(undefined)).toBeUndefined();
    expect(trustLocationWarning("home")).toBe(
      "This is your home folder. AgenC can work on every file in it.",
    );
    expect(trustLocationWarning("root")).toBe(
      "This is the root of the disk. AgenC can work on every file on it.",
    );
  });

  it("states which protections still apply", () => {
    expect(trustSafetyNote(false, false)).toBe(
      "Approvals and the sandbox still apply.",
    );
    expect(trustSafetyNote(true, false)).toBe(
      "Approvals are off for this run. The sandbox still applies.",
    );
    expect(trustSafetyNote(true, true)).toBe(
      "Approvals and the sandbox are off for this run.",
    );
  });

  it("never uses an em dash in card copy", () => {
    const copy = [
      trustReviewLead({ repoItems: [repo], userItems: [user] }),
      trustReviewLead({ repoItems: [repo], userItems: [] }),
      trustReviewLead({ repoItems: [], userItems: [user] }),
      trustLocationWarning("home"),
      trustLocationWarning("root"),
      trustSafetyNote(false, false),
      trustSafetyNote(true, false),
      trustSafetyNote(true, true),
    ].join("\n");
    expect(copy).not.toContain("\u2014");
  });

  it("puts each label on its first row and collapses long lists", () => {
    const rows = trustItemRows([
      { label: "Hooks", values: ["a", "b", "c", "d", "e", "f"] },
      { label: "Shell env", values: ["API_URL"] },
    ]);
    expect(rows.map((row) => [row.label, row.value])).toEqual([
      ["Hooks", "a"],
      ["", "b"],
      ["", "c"],
      ["", "d"],
      ["", "+2 more"],
      ["Shell env", "API_URL"],
    ]);
    expect(rows.filter((row) => row.more)).toHaveLength(1);
  });
});
