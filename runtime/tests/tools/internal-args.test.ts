import { describe, expect, test } from "vitest";

import { stripModelSuppliedAgenCInternalArgs } from "../../src/tools/internal-args.js";

const AGENC_INTERNAL_PREFIX = "__agenc";

function ownProtoInput(): Record<string, unknown> {
  const input = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(input, "__proto__", {
    value: { polluted: true },
    enumerable: true,
    writable: true,
    configurable: true,
  });
  input.path = "/workspace";
  input[`${AGENC_INTERNAL_PREFIX}SessionAllowedRoots`] = ["/etc"];
  return input;
}

describe("stripModelSuppliedAgenCInternalArgs", () => {
  test("returns the same object when no trusted-channel keys are present", () => {
    const input = { path: "/workspace", command: "ls" };
    expect(stripModelSuppliedAgenCInternalArgs(input)).toBe(input);
  });

  test("drops every __agenc* key the model could use to widen confinement", () => {
    const input = {
      path: "/workspace",
      __agencSessionAllowedRoots: ["/etc"],
      __agencSessionId: "forged",
      __agenc: "prefix-only",
    };
    const stripped = stripModelSuppliedAgenCInternalArgs(input);

    expect(stripped).toEqual({ path: "/workspace" });
    expect(stripped).not.toBe(input);
    expect(input.__agencSessionAllowedRoots).toEqual(["/etc"]);
    expect(Object.keys(stripped).some((key) => key.startsWith(AGENC_INTERNAL_PREFIX))).toBe(
      false,
    );
  });

  test("keeps keys that only resemble the trusted prefix", () => {
    const input = {
      _agencSessionId: "kept",
      __AGENCSessionId: "kept-case",
      agencSessionId: "kept-plain",
      allowedRoots: ["/workspace"],
    };
    expect(stripModelSuppliedAgenCInternalArgs(input)).toBe(input);
  });

  test("does not walk nested objects the model already owns", () => {
    const input = {
      nested: { __agencSessionId: "nested-forged" },
    };
    expect(stripModelSuppliedAgenCInternalArgs(input)).toBe(input);
  });

  test("copies a JSON __proto__ key as an own property instead of applying it", () => {
    const input = ownProtoInput();
    const stripped = stripModelSuppliedAgenCInternalArgs(input);

    expect(stripped.path).toBe("/workspace");
    expect(Object.hasOwn(stripped, `${AGENC_INTERNAL_PREFIX}SessionAllowedRoots`)).toBe(
      false,
    );
    expect(Object.getPrototypeOf(stripped)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(stripped, "__proto__")?.value).toEqual({
      polluted: true,
    });
    expect(
      ({} as { polluted?: boolean }).polluted,
    ).toBeUndefined();
  });
});
