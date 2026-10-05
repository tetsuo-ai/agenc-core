import { APIUserAbortError as PublicAbortError } from "@anthropic-ai/sdk";
import { APIUserAbortError as LeafAbortError } from "@anthropic-ai/sdk/core/error";
import { describe, expect, it } from "vitest";
import { isAbortError as isRuntimeAbort } from "../../src/errors/runtime.js";
import { isAbortError as isUtilityAbort } from "../../src/utils/errors.js";

describe("SDK abort error identity", () => {
  it("retains the public SDK class and instanceof recognition even when its name is changed", () => {
    expect(LeafAbortError).toBe(PublicAbortError);
    const error = new PublicAbortError();
    error.name = "minified-class-name";
    expect(isRuntimeAbort(error)).toBe(true);
    expect(isUtilityAbort(error)).toBe(true);
    expect(isRuntimeAbort(new Error("ordinary failure"))).toBe(false);
    expect(isUtilityAbort(new Error("ordinary failure"))).toBe(false);
  });
});
