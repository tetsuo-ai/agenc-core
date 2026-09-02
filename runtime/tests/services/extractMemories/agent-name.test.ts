import { describe, expect, it } from "vitest";

import { assertValidAgentName } from "../../../src/agents/registry.js";
import { MEMORY_EXTRACTION_AGENT_NAME } from "../../../src/services/extractMemories/extractMemories.js";

describe("memory extraction child name", () => {
  it("passes the delegate's agent-name validator", () => {
    // Live failure: "memory_extraction_failed: child outcome rejected: agent_name
    // must use only lowercase letters, digits, and underscores" with the old
    // hyphenated name; the extraction could never run.
    expect(() => assertValidAgentName(MEMORY_EXTRACTION_AGENT_NAME)).not.toThrow();
    expect(() => assertValidAgentName("memory-extraction")).toThrow();
  });
});
