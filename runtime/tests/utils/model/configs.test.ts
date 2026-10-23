import { describe, expect, test } from "vitest";

import { parseClaudeModelId } from "../../../src/utils/model/claudeModelId.js";
import { ALL_MODEL_CONFIGS } from "../../../src/utils/model/configs.js";

// Amazon Bedrock names Claude models `anthropic.claude-<model>`, optionally
// behind a cross-region inference-profile prefix. A rebranding pass once
// rewrote that segment to `anthropic.agenc-`, which no AWS account serves.
const BEDROCK_CLAUDE_ID = /^(?:(?:us|eu|apac|global)\.)?anthropic\.claude-/u;

const ROWS = Object.entries(ALL_MODEL_CONFIGS);
// The shared Claude id parser reads Claude 4 and later ids only.
const PARSED_ROWS = ROWS.filter(
  ([, config]) => parseClaudeModelId(config.firstParty) !== undefined,
);

describe("Bedrock model ids in the model table", () => {
  test.each(ROWS)("%s uses the AWS spelling", (_key, config) => {
    expect(config.bedrock).toMatch(BEDROCK_CLAUDE_ID);
    expect(config.bedrock).not.toMatch(/agenc/iu);
  });

  test.each(PARSED_ROWS)("%s names the same model on Bedrock", (_key, config) => {
    const firstParty = parseClaudeModelId(config.firstParty);
    const bedrock = parseClaudeModelId(config.bedrock);

    expect(bedrock?.platform).toBe("bedrock");
    expect(bedrock?.canonical).toBe(firstParty?.canonical);
    expect(bedrock?.snapshot).toBe(firstParty?.snapshot);
  });
});
