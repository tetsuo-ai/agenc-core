import { describe, expect, test } from "vitest";

import {
  READ_ONLY_COMMAND_NOTICE,
  readOnlyCommandNotice,
} from "../../../src/tools/system/exec-read-only-notice.js";

describe("readOnlyCommandNotice", () => {
  test.each([
    "touch: cannot touch 'notes/x': Read-only file system",
    "chmod: Operation not permitted",
    "open: EROFS",
    "unlink: EPERM",
    "npm error getaddrinfo EAI_AGAIN registry.npmjs.org",
    "getaddrinfo ENOTFOUND example.com",
    "connect ENETUNREACH",
    "curl: (6) Could not resolve host: example.com",
    "Could not resolve proxy: cache.local",
    "Temporary failure in name resolution",
    "Name or service not known",
    "Network is unreachable",
  ])("names AgenC's read-only choice for %s", (output) => {
    expect(readOnlyCommandNotice(output, 1)).toBe(READ_ONLY_COMMAND_NOTICE);
    expect(readOnlyCommandNotice(output, null)).toBe(READ_ONLY_COMMAND_NOTICE);
  });

  test("does not invent a notice for success or an unrelated failure", () => {
    expect(readOnlyCommandNotice("Read-only file system", 0)).toBeNull();
    expect(readOnlyCommandNotice("permission denied", 1)).toBeNull();
    expect(readOnlyCommandNotice("ECONNREFUSED", 1)).toBeNull();
    expect(readOnlyCommandNotice("missing package.json", 1)).toBeNull();
    expect(readOnlyCommandNotice("", 1)).toBeNull();
  });
});
