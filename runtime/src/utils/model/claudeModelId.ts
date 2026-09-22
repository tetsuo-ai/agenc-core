/**
 * One boundary-aware reading of a Claude model id, shared by routing
 * (canonical names, Bedrock profile selection), pricing and capability
 * checks, so `claude-opus-5-5` and `claude-opus-5` can never be confused
 * through a substring match in either direction.
 *
 * Recognized spellings; anything else returns undefined:
 * - Claude API: `claude-<family>-<major>[-<minor>]`, optionally with a
 *   dated snapshot (`-YYYYMMDD`) and optionally qualified as
 *   `anthropic/<id>` or `anthropic:<id>`.
 * - Amazon Bedrock: `[<geo>.]anthropic.claude-<...>` (and this
 *   repository's `anthropic.agenc-<...>` inference-profile spelling), with
 *   an optional snapshot and `-v<N>[:<N>]` version, optionally inside an
 *   inference-profile or foundation-model ARN.
 * - Google Cloud Vertex AI: `claude-<...>@YYYYMMDD`.
 * - Any of these followed by the client-side `[1m]` tag.
 *
 * The minor version is one or two digits after `-` or `.` and must end at a
 * boundary: `claude-opus-5.5` is Opus 5.5 (the dotted spelling GitHub
 * Copilot and OpenRouter publish), `claude-opus-5-50` is a different,
 * unknown minor, and `claude-opus-5-20260601` is an Opus 5 snapshot. Kept
 * dependency-free so the wire layer can import it.
 */

export type ClaudeModelFamily = "opus" | "sonnet" | "haiku" | "fable" | "mythos";

export interface ClaudeModelId {
  readonly family: ClaudeModelFamily;
  readonly major: number;
  /** Absent for a bare major such as `claude-opus-5`. */
  readonly minor?: number;
  /** `claude-<family>-<major>[-<minor>]`, the Claude API spelling. */
  readonly canonical: string;
  /** Dated snapshot (`-YYYYMMDD` or Vertex `@YYYYMMDD`) when present. */
  readonly snapshot?: string;
  readonly platform: "anthropic" | "bedrock" | "vertex";
}

export const CLAUDE_OPUS_5_5 = "claude-opus-5-5";

const CLAUDE_MODEL_ID = new RegExp(
  "^(?:anthropic[/:])?" +
    "(?:" +
    "(?<bedrock>(?:arn:aws[a-z-]*:bedrock:[a-z0-9-]*:\\d*:" +
    "(?:inference-profile|foundation-model)/)?" +
    "(?:[a-z]+(?:-[a-z]+)?\\.)?anthropic\\.(?:claude|agenc))" +
    "|claude" +
    ")" +
    "-(?<family>opus|sonnet|haiku|fable|mythos)" +
    "-(?<major>\\d{1,2})" +
    "(?:[.-](?<minor>\\d{1,2})(?!\\d))?" +
    "(?:-(?<snapshot>\\d{8})|@(?<vertexSnapshot>\\d{8}))?" +
    "(?:-v\\d+(?::\\d+)?)?" +
    "(?:\\[1m\\])?$",
  "u",
);

export function parseClaudeModelId(model: string): ClaudeModelId | undefined {
  const groups = CLAUDE_MODEL_ID.exec(model.trim().toLowerCase())?.groups;
  if (groups === undefined) return undefined;
  const family = groups.family as ClaudeModelFamily;
  const major = groups.major!;
  const minor = groups.minor;
  const snapshot = groups.snapshot ?? groups.vertexSnapshot;
  return {
    family,
    major: Number.parseInt(major, 10),
    ...(minor !== undefined ? { minor: Number.parseInt(minor, 10) } : {}),
    canonical: `claude-${family}-${major}${minor !== undefined ? `-${minor}` : ""}`,
    ...(snapshot !== undefined ? { snapshot } : {}),
    platform: groups.bedrock !== undefined
      ? "bedrock"
      : groups.vertexSnapshot !== undefined
        ? "vertex"
        : "anthropic",
  };
}

/** True when `model` is exactly the Claude model `canonical`, in any recognized spelling. */
export function isClaudeModel(model: string, canonical: string): boolean {
  return parseClaudeModelId(model)?.canonical === canonical;
}
