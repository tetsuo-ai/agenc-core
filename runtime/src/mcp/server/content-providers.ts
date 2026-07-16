/**
 * MCP prompt + resource providers for `agenc mcp serve`.
 *
 * The runtime already loads skills (natural MCP prompts) and memory /
 * instruction files (natural MCP resources), but the MCP server exposed
 * only tools — other MCP hosts saw none of it. These providers surface
 * that content read-only:
 *
 *   - Prompts: skills discovered from the standard skill roots
 *     (`<root>/<name>/SKILL.md` and legacy `<root>/<name>.md`). Skills
 *     marked `disable-model-invocation: true` are NOT exposed — an MCP
 *     client's model can trigger prompts/get, so the flag is honored
 *     the same way it gates in-process model invocation.
 *   - Resources: memory files (via the same scanner the runtime uses)
 *     plus explicitly-passed instruction files (AGENC.md tiers).
 *     Canonical containment rejects symlink escapes, and `readResource`
 *     only serves URIs minted by a fresh listing — it never resolves
 *     client-supplied paths. Only the selected resource body is read,
 *     then its contents pass through the memory secret redactor.
 *
 * @module
 */
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";

import {
  detectSessionFileType,
  redactSecrets,
  scanMemoryFiles,
} from "../../memory/index.js";
import {
  parseBooleanFrontmatter,
  parseFrontmatter,
} from "../../utils/frontmatterParser.js";
import type {
  McpGetPromptResult,
  McpPromptDefinition,
  McpPromptProvider,
  McpReadResourceResult,
  McpResourceDefinition,
  McpResourceProvider,
} from "../../mcp-server/types.js";

export interface SkillPromptProviderOptions {
  /** Directories whose children are skills (`<dir>/<name>/SKILL.md` or `<dir>/<name>.md`). */
  readonly skillRoots: readonly string[];
  /** Canonical containment root; candidates resolving outside it are omitted. */
  readonly scopeRoot?: string;
}

interface DiscoveredSkill {
  readonly name: string;
  readonly filePath: string;
  readonly description: string;
  readonly argumentHint: string | undefined;
  readonly rawContent: string;
}

async function canonicalScopeRoot(
  scopeRoot: string | undefined,
): Promise<string | null> {
  if (scopeRoot === undefined) return null;
  try {
    return await realpath(scopeRoot);
  } catch {
    return null;
  }
}

function isSameOrChildPath(scopeRoot: string, candidate: string): boolean {
  const offset = relative(scopeRoot, candidate);
  return offset === "" || (!offset.startsWith("..") && !isAbsolute(offset));
}

async function readScopedRegularFile(
  filePath: string,
  scopeRoot: string | null,
  readContent: (canonicalPath: string) => Promise<string> = async (
    canonicalPath,
  ) => await readFile(canonicalPath, "utf8"),
): Promise<{
  readonly canonicalPath: string;
  readonly rawContent: string;
} | null> {
  const canonicalPath = await resolveScopedRegularFile(filePath, scopeRoot);
  if (canonicalPath === null) return null;
  try {
    return { canonicalPath, rawContent: await readContent(canonicalPath) };
  } catch {
    return null;
  }
}

async function resolveScopedRegularFile(
  filePath: string,
  scopeRoot: string | null,
): Promise<string | null> {
  try {
    const fileStat = await lstat(filePath);
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) return null;
    const canonicalPath = await realpath(filePath);
    if (scopeRoot !== null && !isSameOrChildPath(scopeRoot, canonicalPath)) {
      return null;
    }
    return canonicalPath;
  } catch {
    return null;
  }
}

async function discoverSkills(
  options: SkillPromptProviderOptions,
): Promise<Map<string, DiscoveredSkill>> {
  const skills = new Map<string, DiscoveredSkill>();
  const scopeRoot = await canonicalScopeRoot(options.scopeRoot);
  if (options.scopeRoot !== undefined && scopeRoot === null) return skills;
  for (const root of options.skillRoots) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const candidate = entry.isDirectory()
        ? { name: entry.name, filePath: join(root, entry.name, "SKILL.md") }
        : entry.name.endsWith(".md")
          ? {
              name: entry.name.slice(0, -".md".length),
              filePath: join(root, entry.name),
            }
          : null;
      if (candidate === null || skills.has(candidate.name)) continue;
      const file = await readScopedRegularFile(candidate.filePath, scopeRoot);
      if (file === null) continue;
      const { frontmatter } = parseFrontmatter(
        file.rawContent,
        file.canonicalPath,
      );
      if (parseBooleanFrontmatter(frontmatter["disable-model-invocation"])) {
        continue;
      }
      skills.set(candidate.name, {
        name: candidate.name,
        filePath: file.canonicalPath,
        description:
          typeof frontmatter.description === "string"
            ? frontmatter.description
            : `Skill: ${candidate.name}`,
        argumentHint:
          frontmatter["argument-hint"] != null
            ? String(frontmatter["argument-hint"])
            : undefined,
        rawContent: file.rawContent,
      });
    }
  }
  return skills;
}

export function createSkillPromptProvider(
  options: SkillPromptProviderOptions,
): McpPromptProvider {
  return {
    async listPrompts(): Promise<readonly McpPromptDefinition[]> {
      const skills = await discoverSkills(options);
      return [...skills.values()].map((skill) => ({
        name: skill.name,
        description: skill.description,
        arguments: [
          {
            name: "arguments",
            description:
              skill.argumentHint ?? "Optional arguments for the skill",
            required: false,
          },
        ],
      }));
    },
    async getPrompt(
      name: string,
      args?: Readonly<Record<string, string>>,
    ): Promise<McpGetPromptResult | null> {
      const skills = await discoverSkills(options);
      const skill = skills.get(name);
      if (skill === undefined) return null;
      const { content } = parseFrontmatter(
        skill.rawContent,
        skill.filePath,
      );
      const argumentText = args?.arguments ?? "";
      const text = content.includes("$ARGUMENTS")
        ? content.replaceAll("$ARGUMENTS", argumentText)
        : argumentText.length > 0
          ? `${content}\n\nARGUMENTS: ${argumentText}`
          : content;
      return {
        description: skill.description,
        messages: [{ role: "user", content: { type: "text", text } }],
      };
    },
  };
}

export interface MemoryResourceProviderOptions {
  /** Memory directories scanned with the runtime's memory scanner. */
  readonly memoryDirs: readonly string[];
  /** Explicit instruction files (AGENC.md tiers). Listed only if they exist. */
  readonly instructionFiles?: readonly string[];
  /** Canonical containment root; candidates resolving outside it are omitted. */
  readonly scopeRoot?: string;
  /** Resource body reader. Exposed for deterministic embedding and tests. */
  readonly readResourceContent?: (canonicalPath: string) => Promise<string>;
}

const MEMORY_URI_SCHEME = "agenc-memory://";
const INSTRUCTIONS_URI_SCHEME = "agenc-instructions://";

interface ListedResource {
  readonly definition: McpResourceDefinition;
  readonly filePath: string;
}

async function listMemoryResources(
  options: MemoryResourceProviderOptions,
): Promise<Map<string, ListedResource>> {
  const resources = new Map<string, ListedResource>();
  const scopeRoot = await canonicalScopeRoot(options.scopeRoot);
  if (options.scopeRoot !== undefined && scopeRoot === null) return resources;
  for (const [dirIndex, dir] of options.memoryDirs.entries()) {
    const headers = await scanMemoryFiles(dir);
    for (const header of headers) {
      // Session memory/transcripts are excluded outright — same boundary
      // the permission layer enforces for in-process reads.
      if (detectSessionFileType(header.filePath) !== null) continue;
      const canonicalPath = await resolveScopedRegularFile(
        header.filePath,
        scopeRoot,
      );
      if (canonicalPath === null) continue;
      const uri = `${MEMORY_URI_SCHEME}${dirIndex}/${header.filename}`;
      resources.set(uri, {
        definition: {
          uri,
          name: header.filename,
          ...(header.description !== null
            ? { description: header.description }
            : {}),
          mimeType: "text/markdown",
        },
        filePath: canonicalPath,
      });
    }
    const entrypoint = join(dir, "MEMORY.md");
    const canonicalEntrypoint = await resolveScopedRegularFile(
      entrypoint,
      scopeRoot,
    );
    if (canonicalEntrypoint !== null) {
      const uri = `${MEMORY_URI_SCHEME}${dirIndex}/MEMORY.md`;
      resources.set(uri, {
        definition: {
          uri,
          name: "MEMORY.md",
          description: "Memory index",
          mimeType: "text/markdown",
        },
        filePath: canonicalEntrypoint,
      });
    }
  }
  for (const [fileIndex, filePath] of (
    options.instructionFiles ?? []
  ).entries()) {
    const canonicalPath = await resolveScopedRegularFile(filePath, scopeRoot);
    if (canonicalPath === null) continue;
    if (detectSessionFileType(filePath) !== null) continue;
    const uri = `${INSTRUCTIONS_URI_SCHEME}${fileIndex}/${basename(filePath)}`;
    resources.set(uri, {
      definition: {
        uri,
        name: basename(filePath),
        description: `Project instructions (${filePath})`,
        mimeType: "text/markdown",
      },
      filePath: canonicalPath,
    });
  }
  return resources;
}

export function createMemoryResourceProvider(
  options: MemoryResourceProviderOptions,
): McpResourceProvider {
  return {
    async listResources(): Promise<readonly McpResourceDefinition[]> {
      const resources = await listMemoryResources(options);
      return [...resources.values()].map((resource) => resource.definition);
    },
    async readResource(uri: string): Promise<McpReadResourceResult | null> {
      // Path bounding: only URIs from a fresh listing are readable. The
      // client-supplied uri is a map key, never a filesystem path.
      const resources = await listMemoryResources(options);
      const resource = resources.get(uri);
      if (resource === undefined) return null;
      const scopeRoot = await canonicalScopeRoot(options.scopeRoot);
      if (options.scopeRoot !== undefined && scopeRoot === null) return null;
      const file = await readScopedRegularFile(
        resource.filePath,
        scopeRoot,
        options.readResourceContent,
      );
      if (file === null) return null;
      return {
        contents: [
          {
            uri,
            mimeType: "text/markdown",
            text: redactSecrets(file.rawContent),
          },
        ],
      };
    },
  };
}
