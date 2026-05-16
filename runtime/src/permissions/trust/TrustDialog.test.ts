import { describe, expect, it } from "vitest";

import { trustDialogOptionLabel } from "./TrustDialog.js";

describe("trustDialogOptionLabel", () => {
  it("shows pending copy only on the selected trust action", () => {
    expect(trustDialogOptionLabel("trust", "trust", true)).toBe("Accepting...");
    expect(trustDialogOptionLabel("exit", "trust", true)).toBe("No, exit");
  });

  it("shows exit pending copy when the user rejects project trust", () => {
    expect(trustDialogOptionLabel("trust", "exit", true)).toBe(
      "Yes, I trust this project",
    );
    expect(trustDialogOptionLabel("exit", "exit", true)).toBe("Exiting...");
  });
});
