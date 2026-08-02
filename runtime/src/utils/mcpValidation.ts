import type {
  ContentBlockParam,
  ImageBlockParam,
  TextBlockParam,
} from "@anthropic-ai/sdk/resources/index.mjs";
import {
  createTokenAccountingRequest,
  estimateTokenAccountingRequest,
  type TokenAccountingResult,
} from "../llm/token-accounting.js";
import type { LLMMessage } from "../llm/types.js";
import { compressImageBlock } from "./imageResizer.js";

export const MCP_TOKEN_COUNT_THRESHOLD_FACTOR = 0.5;
const DEFAULT_MAX_MCP_OUTPUT_TOKENS = 25000;
const BASE64_ENCODED_BYTES_PER_SOURCE_BYTE = 4 / 3;

/**
 * Resolve the MCP output token cap. Precedence:
 *   1. MAX_MCP_OUTPUT_TOKENS env var (explicit user override)
 *   2. tengu_satin_quoll GrowthBook flag's `mcp_tool` key (tokens, not chars —
 *      unlike the other keys in that map which getPersistenceThreshold reads
 *      as chars; MCP has its own truncation layer upstream of that)
 *   3. Hardcoded default
 */
export function getMaxMcpOutputTokens(): number {
  const envValue = process.env.MAX_MCP_OUTPUT_TOKENS;
  if (envValue) {
    const parsed = parseInt(envValue, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  const overrides: Record<string, number> | null = {};
  const override = overrides?.["mcp_tool"];
  if (
    typeof override === "number" &&
    Number.isFinite(override) &&
    override > 0
  ) {
    return override;
  }
  return DEFAULT_MAX_MCP_OUTPUT_TOKENS;
}

export type MCPToolResult = string | ContentBlockParam[] | undefined;

function isTextBlock(block: ContentBlockParam): block is TextBlockParam {
  return block.type === "text";
}

function isImageBlock(block: ContentBlockParam): block is ImageBlockParam {
  return block.type === "image";
}

export function getContentSizeEstimate(content: MCPToolResult): number {
  if (!content) return 0;
  return accountMcpContent(content)?.inputTokens ?? Number.MAX_SAFE_INTEGER;
}

function getMaxMcpOutputBytes(suffix: string): number | undefined {
  const tokenLimit = getMaxMcpOutputTokens();
  const suffixAccounting = accountMcpContent(suffix);
  if (
    suffixAccounting === undefined ||
    !suffixAccounting.admissible ||
    suffixAccounting.inputTokens > tokenLimit
  ) {
    return undefined;
  }
  let lower = 0;
  let upper = tokenLimit;
  while (lower < upper) {
    const candidate = Math.ceil((lower + upper) / 2);
    const result = accountMcpContent(`${"x".repeat(candidate)}${suffix}`);
    if (
      result !== undefined &&
      result.admissible &&
      result.inputTokens <= tokenLimit
    ) {
      lower = candidate;
    } else {
      upper = candidate - 1;
    }
  }
  return lower;
}

function getTruncationMessage(): string {
  return `\n\n[OUTPUT TRUNCATED - exceeded ${getMaxMcpOutputTokens()} token limit]

The tool output was truncated. If this MCP server provides pagination or filtering tools, use them to retrieve specific portions of the data. If pagination is not available, inform the user that you are working with truncated output and results may be incomplete.`;
}

function truncateString(content: string, maxBytes: number): string {
  if (new TextEncoder().encode(content).byteLength <= maxBytes) {
    return content;
  }
  let bytes = 0;
  let endIndex = 0;
  const encoder = new TextEncoder();
  const encodedCharacter = new Uint8Array(4);
  for (const character of content) {
    const characterBytes = encoder.encodeInto(
      character,
      encodedCharacter,
    ).written;
    if (bytes + characterBytes > maxBytes) break;
    bytes += characterBytes;
    endIndex += character.length;
  }
  return content.slice(0, endIndex);
}

async function truncateContentBlocks(
  blocks: ContentBlockParam[],
  maxBytes: number,
): Promise<ContentBlockParam[]> {
  const result: ContentBlockParam[] = [];
  let currentBytes = 0;
  const encoder = new TextEncoder();

  for (const block of blocks) {
    if (isTextBlock(block)) {
      const remainingBytes = maxBytes - currentBytes;
      if (remainingBytes <= 0) break;

      const blockBytes = encoder.encode(block.text).byteLength;
      if (blockBytes <= remainingBytes) {
        result.push(block);
        currentBytes += blockBytes;
      } else {
        result.push({
          type: "text",
          text: truncateString(block.text, remainingBytes),
        });
        break;
      }
    } else if (isImageBlock(block)) {
      if (block.source.type !== "base64") {
        // Remote/provider-owned image expansion has no local byte bound.
        continue;
      }
      const imageBytes = encoder.encode(block.source.data).byteLength;
      if (currentBytes + imageBytes <= maxBytes) {
        result.push(block);
        currentBytes += imageBytes;
      } else {
        const remainingBytes = maxBytes - currentBytes;
        if (remainingBytes > 0) {
          const remainingSourceBytes = Math.floor(
            remainingBytes / BASE64_ENCODED_BYTES_PER_SOURCE_BYTE,
          );
          try {
            const compressedBlock = await compressImageBlock(
              block,
              remainingSourceBytes,
            );
            if (compressedBlock.source.type === "base64") {
              const compressedBytes = encoder.encode(
                compressedBlock.source.data,
              ).byteLength;
              if (currentBytes + compressedBytes <= maxBytes) {
                result.push(compressedBlock);
                currentBytes += compressedBytes;
              }
            }
          } catch {
            // A failed/uncertain image accounting path is rejected by omission.
          }
        }
      }
    } else {
      // Provider-specific blocks have no proven local upper bound. Reject them
      // by omission instead of preserving uncertain content after truncation.
      continue;
    }
  }

  return result;
}

export async function mcpContentNeedsTruncation(
  content: MCPToolResult,
): Promise<boolean> {
  if (!content) return false;

  const accounting = accountMcpContent(content);
  if (accounting === undefined || !accounting.admissible) return true;
  const contentSizeEstimate = accounting.inputTokens;
  if (
    contentSizeEstimate <=
    getMaxMcpOutputTokens() * MCP_TOKEN_COUNT_THRESHOLD_FACTOR
  ) {
    return false;
  }
  return contentSizeEstimate > getMaxMcpOutputTokens();
}

export async function truncateMcpContent(
  content: MCPToolResult,
): Promise<MCPToolResult> {
  if (!content) return content;

  const truncationMsg = getTruncationMessage();
  const maxBytes = getMaxMcpOutputBytes(truncationMsg);
  if (maxBytes === undefined) return undefined;

  if (typeof content === "string") {
    return truncateString(content, maxBytes) + truncationMsg;
  } else {
    const truncatedBlocks = await truncateContentBlocks(
      content as ContentBlockParam[],
      maxBytes,
    );
    truncatedBlocks.push({ type: "text", text: truncationMsg });
    return truncatedBlocks;
  }
}

export async function truncateMcpContentIfNeeded(
  content: MCPToolResult,
): Promise<MCPToolResult> {
  if (!(await mcpContentNeedsTruncation(content))) {
    return content;
  }

  const truncated = await truncateMcpContent(content);
  if (truncated === undefined) return undefined;
  const accounting = accountMcpContent(truncated);
  return accounting !== undefined &&
    accounting.admissible &&
    accounting.inputTokens <= getMaxMcpOutputTokens()
    ? truncated
    : undefined;
}

function accountMcpContent(
  content: Exclude<MCPToolResult, undefined>,
): TokenAccountingResult | undefined {
  const message: LLMMessage = {
    // Standalone MCP output has no preceding assistant tool-call in this
    // validation layer. Use a preserved envelope role so ordinary wire
    // normalization cannot discard the content as an orphan tool result.
    role: "user",
    content: content as LLMMessage["content"],
  };
  try {
    return estimateTokenAccountingRequest(
      createTokenAccountingRequest({
        provider: "mcp",
        model: "mcp-tool-output",
        messages: [message],
        options: {},
        reservedOutputTokens: 0,
      }),
    );
  } catch {
    return undefined;
  }
}
