import type { Resource } from "@modelcontextprotocol/sdk/types.js";
import {
  ListResourcesResultSchema,
  ReadResourceResultSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { normalizeNameForMCP } from "../services/mcp/normalization.js";
import type { MCPServerConnection } from "../services/mcp/types.js";
import type { Command } from "../types/command.js";
import { errorMessage } from "../utils/errors.js";
import type { FrontmatterData } from "../utils/frontmatterParser.js";
import { parseFrontmatter } from "../utils/frontmatterParser.js";
import { logMCPError } from "../utils/log.js";
import { memoizeWithLRU } from "../utils/memoize.js";
import { getMCPSkillBuilders } from "./mcpSkillBuilders.js";

import "./loadSkillsDir.js";

const MCP_SKILL_URI_PREFIX = "skill://";
const MAX_MCP_SKILLS_PER_SERVER = 64;
const MAX_MCP_RESOURCE_PAGES = 32;
const MAX_MCP_SKILL_BYTES = 256 * 1024;
const MCP_SKILLS_FETCH_CACHE_SIZE = 50;

type SkillResource = Resource & {
  readonly uri: string;
  readonly name?: string;
  readonly description?: string;
};

type ReadResourceContent = {
  readonly uri?: string;
  readonly mimeType?: string;
  readonly text?: string;
  readonly blob?: string;
};

type ReadResourceResult = {
  readonly contents?: readonly ReadResourceContent[];
};

function isSkillResource(resource: Resource): resource is SkillResource {
  return (
    typeof resource.uri === "string" &&
    resource.uri.startsWith(MCP_SKILL_URI_PREFIX)
  );
}

function skillIdFromResource(resource: SkillResource): string {
  const uriName = resource.uri.slice(MCP_SKILL_URI_PREFIX.length).replace(/^\/+/u, "");
  const candidate =
    typeof resource.name === "string" && resource.name.trim().length > 0
      ? resource.name.trim()
      : uriName;
  const normalized = normalizeNameForMCP(candidate.replace(/^\/+/u, ""));
  return normalized.length > 0 ? normalized : "skill";
}

function commandNameForResource(serverName: string, resource: SkillResource): string {
  return `mcp__${normalizeNameForMCP(serverName)}__${skillIdFromResource(resource)}`;
}

async function listSkillResources(
  client: Extract<MCPServerConnection, { type: "connected" }>,
): Promise<readonly SkillResource[]> {
  const skillResources: SkillResource[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (let pagesRead = 0; pagesRead < MAX_MCP_RESOURCE_PAGES; pagesRead += 1) {
    if (cursor !== undefined) {
      if (seenCursors.has(cursor)) {
        logMCPError(
          client.name,
          `Stopped MCP skill resource pagination at repeated cursor ${cursor}`,
        );
        return skillResources;
      }
      seenCursors.add(cursor);
    }

    const result = await client.client.request(
      {
        method: "resources/list",
        ...(cursor ? { params: { cursor } } : {}),
      },
      ListResourcesResultSchema,
    );
    const resources = Array.isArray(result.resources) ? result.resources : [];
    for (const resource of resources) {
      if (!isSkillResource(resource)) continue;
      skillResources.push(resource);
      if (skillResources.length >= MAX_MCP_SKILLS_PER_SERVER) {
        return skillResources;
      }
    }
    cursor =
      typeof result.nextCursor === "string" && result.nextCursor.length > 0
        ? result.nextCursor
        : undefined;
    if (cursor === undefined) return skillResources;
  }

  if (cursor !== undefined) {
    logMCPError(
      client.name,
      `Stopped MCP skill resource pagination after ${MAX_MCP_RESOURCE_PAGES} pages`,
    );
  }

  return skillResources;
}

async function readSkillResourceText(
  client: Extract<MCPServerConnection, { type: "connected" }>,
  resource: SkillResource,
): Promise<string | null> {
  const result = (await client.client.request(
    { method: "resources/read", params: { uri: resource.uri } },
    ReadResourceResultSchema,
  )) as ReadResourceResult;
  const text = result.contents?.find(
    (content) => typeof content.text === "string",
  )?.text;
  if (typeof text !== "string") return null;
  if (Buffer.byteLength(text, "utf8") > MAX_MCP_SKILL_BYTES) {
    logMCPError(
      client.name,
      `Skipped MCP skill resource ${resource.uri}: content exceeds ${MAX_MCP_SKILL_BYTES} bytes`,
    );
    return null;
  }
  return text;
}

function safeMcpFrontmatter(
  frontmatter: FrontmatterData,
): FrontmatterData {
  const safe: FrontmatterData = {};
  for (const key of [
    "name",
    "description",
    "arguments",
    "argument-hint",
    "when_to_use",
    "version",
  ]) {
    if (frontmatter[key] !== undefined) {
      safe[key] = frontmatter[key];
    }
  }
  return safe;
}

async function createCommandFromResource(
  client: Extract<MCPServerConnection, { type: "connected" }>,
  resource: SkillResource,
): Promise<Command | null> {
  const markdown = await readSkillResourceText(client, resource);
  if (markdown === null) return null;

  const { frontmatter, content } = parseFrontmatter(markdown, resource.uri);
  const commandName = commandNameForResource(client.name, resource);
  const sanitizedFrontmatter = safeMcpFrontmatter(frontmatter);
  const displayName =
    typeof sanitizedFrontmatter.name === "string" &&
    sanitizedFrontmatter.name.trim().length > 0
      ? sanitizedFrontmatter.name.trim()
      : resource.name;
  const frontmatterWithResourceFallback = {
    ...sanitizedFrontmatter,
    ...(displayName ? { name: displayName } : {}),
    ...(sanitizedFrontmatter.description === undefined && resource.description
      ? { description: resource.description }
      : {}),
  };
  const builders = getMCPSkillBuilders();
  const parsed = builders.parseSkillFrontmatterFields(
    frontmatterWithResourceFallback,
    content,
    commandName,
  );

  const command = builders.createSkillCommand({
    ...parsed,
    model: parsed.model as string | undefined,
    skillName: commandName,
    markdownContent: content,
    source: "mcp",
    baseDir: undefined,
    loadedFrom: "mcp",
    paths: undefined,
  });
  return {
    ...command,
    disableModelInvocation: false,
    userInvocable: true,
    isMcp: true,
  };
}

function dedupeSkillResourcesByCommandName(
  client: Extract<MCPServerConnection, { type: "connected" }>,
  resources: readonly SkillResource[],
): SkillResource[] {
  const seen = new Set<string>();
  const deduped: SkillResource[] = [];
  for (const resource of resources) {
    const commandName = commandNameForResource(client.name, resource);
    if (seen.has(commandName)) {
      logMCPError(
        client.name,
        `Skipped duplicate MCP skill resource ${resource.uri}: command ${commandName} already exists`,
      );
      continue;
    }
    seen.add(commandName);
    deduped.push(resource);
  }
  return deduped;
}

export const fetchMcpSkillsForClient = memoizeWithLRU(
  async (client: MCPServerConnection): Promise<Command[]> => {
    if (client.type !== "connected" || !client.capabilities.resources) {
      return [];
    }

    try {
      const resources = await listSkillResources(client);
      const uniqueResources = dedupeSkillResourcesByCommandName(client, resources);
      const commands = await Promise.all(
        uniqueResources.map(async (resource) => {
          try {
            return await createCommandFromResource(client, resource);
          } catch (error) {
            logMCPError(
              client.name,
              `Skipped MCP skill resource ${resource.uri}: ${errorMessage(error)}`,
            );
            return null;
          }
        }),
      );
      return commands.filter((command): command is Command => command !== null);
    } catch (error) {
      logMCPError(
        client.name,
        `Failed to fetch MCP skills: ${errorMessage(error)}`,
      );
      return [];
    }
  },
  // Key by name AND server config, not name alone: two sessions may each configure
  // an MCP server with the same name pointing at DIFFERENT servers, which under a
  // name-only key collided (the second session got the first's cached skills).
  // Mirrors getServerCacheKey in services/mcp/client.ts.
  (client: MCPServerConnection) =>
    `${client.name} ${JSON.stringify(client.config ?? {})}`,
  MCP_SKILLS_FETCH_CACHE_SIZE,
);
