import { appendFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";

export interface WikiPaths {
  readonly root: string;
  readonly pagesDir: string;
  readonly sourcesDir: string;
  readonly schemaFile: string;
  readonly indexFile: string;
  readonly logFile: string;
}

export interface WikiInitResult {
  readonly root: string;
  readonly createdFiles: readonly string[];
  readonly alreadyExisted: boolean;
}

export interface WikiStatus {
  readonly initialized: boolean;
  readonly root: string;
  readonly pageCount: number;
  readonly sourceCount: number;
  readonly hasSchema: boolean;
  readonly hasIndex: boolean;
  readonly hasLog: boolean;
  readonly lastUpdatedAt: string | null;
}

export interface WikiIngestResult {
  readonly sourceFile: string;
  readonly sourceNote: string;
  readonly summary: string;
  readonly title: string;
}

export function getWikiPaths(cwd: string): WikiPaths {
  const root = join(cwd, ".agenc", "wiki");
  return {
    root,
    pagesDir: join(root, "pages"),
    sourcesDir: join(root, "sources"),
    schemaFile: join(root, "schema.md"),
    indexFile: join(root, "index.md"),
    logFile: join(root, "log.md"),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function ensureFile(
  filePath: string,
  content: string,
  createdFiles: string[],
  cwd: string,
): Promise<void> {
  try {
    await writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
    createdFiles.push(relative(cwd, filePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

function schemaTemplate(projectName: string): string {
  return `# AgenC Wiki Schema

This wiki stores durable, human-readable project knowledge for ${projectName}.

## Structure

- \`index.md\`: top-level navigation and major topics
- \`log.md\`: append-only update log
- \`pages/\`: durable topic and architecture pages
- \`sources/\`: source ingestion notes and summaries
`;
}

function indexTemplate(projectName: string): string {
  return `# ${projectName} Wiki

## Core Pages

- [Architecture](./pages/architecture.md)

## Sources

- Source notes live in [sources/](./sources/)

## Recent Updates

- See [log.md](./log.md)
`;
}

export async function initializeWiki(cwd: string): Promise<WikiInitResult> {
  const paths = getWikiPaths(cwd);
  await Promise.all([
    mkdir(paths.pagesDir, { recursive: true }),
    mkdir(paths.sourcesDir, { recursive: true }),
  ]);

  const createdFiles: string[] = [];
  const projectName = basename(cwd);
  const timestamp = new Date().toISOString();
  await ensureFile(paths.schemaFile, schemaTemplate(projectName), createdFiles, cwd);
  await ensureFile(paths.indexFile, indexTemplate(projectName), createdFiles, cwd);
  await ensureFile(
    paths.logFile,
    `# Wiki Update Log\n\n- ${timestamp}: Wiki initialized by AgenC\n`,
    createdFiles,
    cwd,
  );
  await ensureFile(
    join(paths.pagesDir, "architecture.md"),
    `# Architecture\n\n## Summary\n\nHigh-level architecture notes for ${projectName}.\n`,
    createdFiles,
    cwd,
  );

  return {
    root: paths.root,
    createdFiles,
    alreadyExisted: createdFiles.length === 0,
  };
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
  if (!(await exists(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listMarkdownFiles(fullPath)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(fullPath);
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

async function lastUpdated(pathsToCheck: readonly string[]): Promise<string | null> {
  const mtimes: number[] = [];
  for (const path of pathsToCheck) {
    try {
      mtimes.push((await stat(path)).mtimeMs);
    } catch {
      /* missing file */
    }
  }
  return mtimes.length === 0 ? null : new Date(Math.max(...mtimes)).toISOString();
}

export async function getWikiStatus(cwd: string): Promise<WikiStatus> {
  const paths = getWikiPaths(cwd);
  const [hasRoot, hasSchema, hasIndex, hasLog, pages, sources] =
    await Promise.all([
      exists(paths.root),
      exists(paths.schemaFile),
      exists(paths.indexFile),
      exists(paths.logFile),
      listMarkdownFiles(paths.pagesDir),
      listMarkdownFiles(paths.sourcesDir),
    ]);
  return {
    initialized: hasRoot && hasSchema && hasIndex && hasLog,
    root: paths.root,
    pageCount: pages.length,
    sourceCount: sources.length,
    hasSchema,
    hasIndex,
    hasLog,
    lastUpdatedAt: await lastUpdated([
      paths.schemaFile,
      paths.indexFile,
      paths.logFile,
      ...pages,
      ...sources,
    ]),
  };
}

function sanitizeSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function summarizeText(input: string, maxLength = 280): string {
  const normalized = input.replace(/\s+/g, " ").trim();
  if (!normalized) return "No summary available.";
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 1).trimEnd()}...`;
}

function extractTitle(fallback: string, content: string): string {
  const line = content.split("\n").map(item => item.trim()).find(Boolean);
  return line ? line.replace(/^#+\s*/, "") || fallback : fallback;
}

async function rebuildIndex(cwd: string): Promise<void> {
  const paths = getWikiPaths(cwd);
  const pages = await listMarkdownFiles(paths.pagesDir);
  const sources = await listMarkdownFiles(paths.sourcesDir);
  const pageLinks = pages.map(file => {
    const rel = relative(paths.root, file).replace(/\\/g, "/");
    return `- [${basename(file, ".md")}](./${rel})`;
  });
  const sourceLinks = sources.map(file => {
    const rel = relative(paths.root, file).replace(/\\/g, "/");
    return `- [${basename(file, ".md")}](./${rel})`;
  });
  await writeFile(
    paths.indexFile,
    `# ${basename(cwd)} Wiki

## Core Pages

${pageLinks.length > 0 ? pageLinks.join("\n") : "- No pages yet"}

## Sources

${sourceLinks.length > 0 ? sourceLinks.join("\n") : "- No sources yet"}

## Recent Updates

- See [log.md](./log.md)
`,
    "utf8",
  );
}

export async function ingestWikiSource(
  cwd: string,
  rawPath: string,
): Promise<WikiIngestResult> {
  await initializeWiki(cwd);
  const resolvedPath = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
  const info = await stat(resolvedPath);
  if (!info.isFile()) throw new Error(`Not a file: ${resolvedPath}`);

  const content = await readFile(resolvedPath, "utf8");
  const relSourcePath = relative(cwd, resolvedPath).replace(/\\/g, "/");
  const ingestedAt = new Date().toISOString();
  const baseName = basename(resolvedPath, extname(resolvedPath));
  const title = extractTitle(baseName, content);
  const summary = summarizeText(content);
  const excerpt = content.split("\n").slice(0, 20).join("\n").trim();
  const slug = sanitizeSlug(`${baseName}-${Date.now()}`) || `source-${Date.now()}`;
  const paths = getWikiPaths(cwd);
  const sourceNotePath = join(paths.sourcesDir, `${slug}.md`);

  await writeFile(
    sourceNotePath,
    `# ${title}

## Source

- Path: \`${relSourcePath}\`
- Ingested at: ${ingestedAt}

## Summary

${summary}

## Excerpt

\`\`\`
${excerpt}
\`\`\`
`,
    "utf8",
  );
  await appendFile(
    paths.logFile,
    `- ${ingestedAt}: Ingested \`${relSourcePath}\` into source note "${title}"\n`,
    "utf8",
  );
  await rebuildIndex(cwd);

  return {
    sourceFile: relSourcePath,
    sourceNote: relative(cwd, sourceNotePath).replace(/\\/g, "/"),
    summary,
    title,
  };
}

function helpText(): string {
  return `Usage: /wiki [init|status|ingest <path>]

Commands:
  /wiki init              Initialize the project wiki
  /wiki status            Show wiki status and counts
  /wiki ingest <path>     Ingest a local file into wiki sources`;
}

function formatInit(result: WikiInitResult): string {
  if (result.alreadyExisted) {
    return `Initialized AgenC wiki at ${result.root}\n\nWiki already existed. No new files were created.`;
  }
  return [
    `Initialized AgenC wiki at ${result.root}`,
    "",
    "Created files:",
    ...result.createdFiles.map(file => `- ${file}`),
  ].join("\n");
}

function formatStatus(status: WikiStatus): string {
  if (!status.initialized) {
    return `AgenC wiki is not initialized in this project.\n\nRun /wiki init to create ${status.root}.`;
  }
  return [
    "AgenC wiki status",
    "",
    `Root: ${status.root}`,
    `Pages: ${status.pageCount}`,
    `Sources: ${status.sourceCount}`,
    `Schema: ${status.hasSchema ? "present" : "missing"}`,
    `Index: ${status.hasIndex ? "present" : "missing"}`,
    `Log: ${status.hasLog ? "present" : "missing"}`,
    `Last updated: ${status.lastUpdatedAt ?? "unknown"}`,
  ].join("\n");
}

function formatIngest(result: WikiIngestResult): string {
  return [
    `Ingested ${result.sourceFile} into the AgenC wiki.`,
    "",
    `Title: ${result.title}`,
    `Source note: ${result.sourceNote}`,
    `Summary: ${result.summary}`,
  ].join("\n");
}

export async function handleWikiCommand(cwd: string, argsRaw: string): Promise<string> {
  const trimmed = argsRaw.trim();
  const normalized = trimmed.toLowerCase();
  if (normalized === "" || normalized === "status") return formatStatus(await getWikiStatus(cwd));
  if (normalized === "help" || normalized === "--help" || normalized === "-h") return helpText();
  if (normalized === "init") return formatInit(await initializeWiki(cwd));
  if (normalized.startsWith("ingest")) {
    const pathArg = trimmed.slice("ingest".length).trim();
    return pathArg ? formatIngest(await ingestWikiSource(cwd, pathArg)) : "Usage: /wiki ingest <local-file-path>";
  }
  return `Unknown wiki subcommand: ${trimmed}\n\n${helpText()}`;
}

export const wikiCommand: SlashCommand = {
  name: "wiki",
  description: "Initialize or inspect the AgenC project wiki",
  immediate: true,
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => ({
      kind: "text",
      text: await handleWikiCommand(ctx.cwd, ctx.argsRaw),
    })),
};

export default wikiCommand;
