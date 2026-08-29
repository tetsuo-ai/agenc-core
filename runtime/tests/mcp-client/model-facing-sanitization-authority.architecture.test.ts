import { readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

import { describe, expect, test } from "vitest";

const sourceRoot = resolve(import.meta.dirname, "../../src");
const authorityName = "mcp-client/model-facing-sanitization.ts";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = resolve(directory, entry);
    return statSync(path).isDirectory()
      ? sourceFiles(path)
      : /\.(?:ts|tsx)$/u.test(entry)
        ? [path]
        : [];
  });
}

describe("single model-facing MCP metadata authority", () => {
  test("keeps sanitizer policy definitions in one module", () => {
    const forbiddenOutsideAuthority =
      /\b(?:HIDDEN_MODEL_TEXT_PATTERN|MAX_MCP_SCHEMA_[A-Z_]+|MCP_SCHEMA_METADATA_KEYS|MCP_SCHEMA_MAP_KEYS)\b|\bfunction\s+(?:sanitizeMcpModelFacingText|sanitizeMcpSchemaNodeForModel|sanitizeMcpInputSchemaForModel|modelFacingMcpToolDescription|truncateUtf8WithMarker)\s*\(/u;
    const violations = sourceFiles(sourceRoot).flatMap((path) => {
      const name = relative(sourceRoot, path).replaceAll("\\", "/");
      if (name === authorityName) return [];
      return forbiddenOutsideAuthority.test(readFileSync(path, "utf8"))
        ? [name]
        : [];
    });

    expect(violations).toEqual([]);
  });

  test("routes both live MCP bridges through the shared authority", () => {
    const canonicalBridge = readFileSync(
      resolve(sourceRoot, "mcp-client/tools.ts"),
      "utf8",
    );
    const agentToolBridge = readFileSync(
      resolve(sourceRoot, "services/mcp/client.ts"),
      "utf8",
    );

    expect(canonicalBridge).toContain(
      'from "./model-facing-sanitization.js"',
    );
    expect(agentToolBridge).toContain(
      "from '../../mcp-client/model-facing-sanitization.js'",
    );
    expect(agentToolBridge).not.toMatch(
      /recursivelySanitizeUnicode\(result\.tools\)/u,
    );
  });
});
