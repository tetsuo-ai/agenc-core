import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve as resolvePath } from "node:path";

import { silentLogger, type Logger } from "../../utils/logger.js";
import { runCommand } from "../../utils/process.js";

type SupportedLanguage =
  | "typescript"
  | "javascript"
  | "python"
  | "rust"
  | "go"
  | "c"
  | "cpp";

export interface CodeIntelSymbol {
  readonly name: string;
  readonly kind: string;
  readonly language: SupportedLanguage;
  readonly filePath: string;
  readonly line: number;
  readonly column: number;
  readonly signature?: string;
  readonly containerName?: string;
}

interface WorkspaceIndexSnapshot {
  readonly workspaceRoot: string;
  readonly fingerprint: string;
  readonly generatedAt: number;
  readonly symbols: readonly CodeIntelSymbol[];
}

interface WorkspaceIndex extends WorkspaceIndexSnapshot {}

export interface CodeIntelManagerOptions {
  readonly persistenceRootDir: string;
  readonly logger?: Logger;
}

const SUPPORTED_EXTENSIONS: Record<string, SupportedLanguage> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hh": "cpp",
  ".hxx": "cpp",
};

const IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  "target",
]);

type TypeScriptModule = typeof import("typescript");

let cachedTypeScriptModule: Promise<TypeScriptModule | null> | undefined;

async function loadTypeScriptModule(): Promise<TypeScriptModule | null> {
  if (!cachedTypeScriptModule) {
    cachedTypeScriptModule = import("typescript")
      .then((mod) => mod as TypeScriptModule)
      .catch(() => null);
  }
  return cachedTypeScriptModule;
}

function detectLanguage(filePath: string): SupportedLanguage | undefined {
  return SUPPORTED_EXTENSIONS[extname(filePath).toLowerCase()];
}

function hashWorkspaceKey(workspaceRoot: string): string {
  return createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 16);
}

function toSnapshotPath(rootDir: string, workspaceRoot: string): string {
  return join(rootDir, "code-intel", `${hashWorkspaceKey(workspaceRoot)}.json`);
}

function computeFingerprint(entries: readonly {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}[]): string {
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(entry.path);
    hash.update("\0");
    hash.update(String(entry.size));
    hash.update("\0");
    hash.update(String(entry.mtimeMs));
    hash.update("\n");
  }
  return hash.digest("hex");
}

function buildSnippetSignature(
  lineText: string | undefined,
  maxChars = 200,
): string | undefined {
  if (!lineText) return undefined;
  const normalized = lineText.trim().replace(/\s+/g, " ");
  return normalized.length > maxChars
    ? `${normalized.slice(0, maxChars - 1)}...`
    : normalized;
}

async function listCandidateFiles(workspaceRoot: string): Promise<string[]> {
  const gitFiles = await runCommand(
    "git",
    ["-C", workspaceRoot, "ls-files", "--cached", "--others", "--exclude-standard"],
    { cwd: workspaceRoot },
  );
  if (gitFiles.exitCode === 0 && gitFiles.stdout.trim().length > 0) {
    return gitFiles.stdout
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => resolvePath(workspaceRoot, entry))
      .filter((entry) => detectLanguage(entry) !== undefined);
  }

  const files: string[] = [];
  const stack = [workspaceRoot];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) {
          stack.push(fullPath);
        }
        continue;
      }
      if (entry.isFile() && detectLanguage(fullPath)) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

function collectMatches(
  text: string,
  pattern: RegExp,
  language: SupportedLanguage,
  filePath: string,
): CodeIntelSymbol[] {
  const lines = text.split(/\r?\n/);
  const results: CodeIntelSymbol[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    pattern.lastIndex = 0;
    const match = pattern.exec(line);
    if (!match) continue;
    const kind = match[1] ?? "symbol";
    const name = match[2] ?? match[1];
    if (!name) continue;
    const column = line.indexOf(name);
    results.push({
      name,
      kind,
      language,
      filePath,
      line: index + 1,
      column: column >= 0 ? column + 1 : 1,
      signature: buildSnippetSignature(line),
    });
  }
  return results;
}

function indexHeuristicSymbols(params: {
  readonly filePath: string;
  readonly language: SupportedLanguage;
  readonly text: string;
}): CodeIntelSymbol[] {
  const { filePath, language, text } = params;
  switch (language) {
    case "python":
      return [
        ...collectMatches(text, /^\s*(class)\s+([A-Za-z_][A-Za-z0-9_]*)/m, language, filePath),
        ...collectMatches(text, /^\s*(def)\s+([A-Za-z_][A-Za-z0-9_]*)/m, language, filePath),
      ];
    case "rust":
      return [
        ...collectMatches(
          text,
          /^\s*(?:pub\s+)?(fn|struct|enum|trait|type)\s+([A-Za-z_][A-Za-z0-9_]*)/m,
          language,
          filePath,
        ),
      ];
    case "go":
      return [
        ...collectMatches(text, /^\s*(func|type)\s+([A-Za-z_][A-Za-z0-9_]*)/m, language, filePath),
      ];
    case "c":
    case "cpp":
      return [
        ...collectMatches(
          text,
          /^\s*(struct|enum|class)\s+([A-Za-z_][A-Za-z0-9_]*)/m,
          language,
          filePath,
        ),
        ...collectMatches(
          text,
          /^\s*(?:[A-Za-z_][A-Za-z0-9_:\s*&<>-]+)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*\)\s*\{/m,
          language,
          filePath,
        ).map((symbol) => ({ ...symbol, kind: "function" })),
      ];
    default:
      return [];
  }
}

async function indexTypeScriptSymbols(params: {
  readonly filePath: string;
  readonly text: string;
}): Promise<CodeIntelSymbol[]> {
  const ts = await loadTypeScriptModule();
  if (!ts) {
    return [];
  }
  const sourceFile = ts.createSourceFile(
    params.filePath,
    params.text,
    ts.ScriptTarget.Latest,
    true,
    params.filePath.endsWith(".tsx") || params.filePath.endsWith(".jsx")
      ? ts.ScriptKind.TSX
      : ts.ScriptKind.TS,
  );
  const symbols: CodeIntelSymbol[] = [];
  const visit = (node: import("typescript").Node, containerName?: string): void => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isTypeAliasDeclaration(node)
    ) {
      const nameNode = node.name;
      if (nameNode) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(
          nameNode.getStart(sourceFile),
        );
        symbols.push({
          name: nameNode.text,
          kind: ts.SyntaxKind[node.kind].replace(/Declaration$/, "").toLowerCase(),
          language: params.filePath.endsWith(".js") ||
              params.filePath.endsWith(".jsx") ||
              params.filePath.endsWith(".mjs") ||
              params.filePath.endsWith(".cjs")
            ? "javascript"
            : "typescript",
          filePath: params.filePath,
          line: line + 1,
          column: character + 1,
          signature: buildSnippetSignature(
            sourceFile.text.slice(node.getStart(sourceFile), node.end).split(/\r?\n/, 1)[0],
          ),
          ...(containerName ? { containerName } : {}),
        });
        containerName = nameNode.text;
      }
    } else if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(
          declaration.name.getStart(sourceFile),
        );
        symbols.push({
          name: declaration.name.text,
          kind: "variable",
          language: params.filePath.endsWith(".js") ||
              params.filePath.endsWith(".jsx") ||
              params.filePath.endsWith(".mjs") ||
              params.filePath.endsWith(".cjs")
            ? "javascript"
            : "typescript",
          filePath: params.filePath,
          line: line + 1,
          column: character + 1,
          signature: buildSnippetSignature(
            sourceFile.text
              .slice(declaration.getStart(sourceFile), declaration.end)
              .split(/\r?\n/, 1)[0],
          ),
          ...(containerName ? { containerName } : {}),
        });
      }
    }
    ts.forEachChild(node, (child) => visit(child, containerName));
  };
  visit(sourceFile);
  return symbols;
}

function uniqueSymbols(symbols: readonly CodeIntelSymbol[]): CodeIntelSymbol[] {
  const seen = new Set<string>();
  const deduped: CodeIntelSymbol[] = [];
  for (const symbol of symbols) {
    const key = [
      symbol.name,
      symbol.kind,
      symbol.filePath,
      symbol.line,
      symbol.column,
    ].join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(symbol);
  }
  return deduped;
}

export class CodeIntelManager {
  private readonly persistenceRootDir: string;
  private readonly logger: Logger;
  private readonly cache = new Map<string, WorkspaceIndex>();

  constructor(options: CodeIntelManagerOptions) {
    this.persistenceRootDir = resolvePath(options.persistenceRootDir);
    this.logger = options.logger ?? silentLogger;
  }

  private async loadSnapshot(
    workspaceRoot: string,
    fingerprint: string,
  ): Promise<WorkspaceIndex | undefined> {
    const snapshotPath = toSnapshotPath(this.persistenceRootDir, workspaceRoot);
    const raw = await readFile(snapshotPath, "utf8").catch(() => undefined);
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as WorkspaceIndexSnapshot;
      if (parsed.workspaceRoot !== workspaceRoot || parsed.fingerprint !== fingerprint) {
        return undefined;
      }
      return parsed;
    } catch (error) {
      this.logger.debug("Failed to parse code-intel snapshot", {
        workspaceRoot,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private async writeSnapshot(index: WorkspaceIndex): Promise<void> {
    const snapshotPath = toSnapshotPath(this.persistenceRootDir, index.workspaceRoot);
    await mkdir(dirname(snapshotPath), { recursive: true }).catch(async () => {
      await mkdir(join(this.persistenceRootDir, "code-intel"), { recursive: true });
    });
    await writeFile(snapshotPath, JSON.stringify(index), "utf8").catch((error) => {
      this.logger.debug("Failed to write code-intel snapshot", {
        workspaceRoot: index.workspaceRoot,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private async buildIndex(workspaceRoot: string): Promise<WorkspaceIndex> {
    const files = await listCandidateFiles(workspaceRoot);
    const fileStats = await Promise.all(
      files.map(async (filePath) => {
        const fileStat = await stat(filePath).catch(() => undefined);
        return fileStat
          ? {
              path: filePath,
              size: fileStat.size,
              mtimeMs: fileStat.mtimeMs,
            }
          : undefined;
      }),
    );
    const fingerprint = computeFingerprint(
      fileStats.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined),
    );
    const cached = this.cache.get(workspaceRoot);
    if (cached?.fingerprint === fingerprint) {
      return cached;
    }
    const persisted = await this.loadSnapshot(workspaceRoot, fingerprint);
    if (persisted) {
      this.cache.set(workspaceRoot, persisted);
      return persisted;
    }

    const symbolSets = await Promise.all(
      files.map(async (filePath) => {
        const language = detectLanguage(filePath);
        if (!language) return [];
        const text = await readFile(filePath, "utf8").catch(() => "");
        if (!text) return [];
        if (language === "typescript" || language === "javascript") {
          return indexTypeScriptSymbols({ filePath, text });
        }
        return indexHeuristicSymbols({ filePath, language, text });
      }),
    );

    const index: WorkspaceIndex = {
      workspaceRoot,
      fingerprint,
      generatedAt: Date.now(),
      symbols: uniqueSymbols(symbolSets.flat()),
    };
    this.cache.set(workspaceRoot, index);
    await this.writeSnapshot(index);
    return index;
  }

  async searchSymbols(params: {
    readonly workspaceRoot: string;
    readonly query?: string;
    readonly language?: string;
    readonly kind?: string;
    readonly maxResults?: number;
  }): Promise<readonly CodeIntelSymbol[]> {
    const index = await this.buildIndex(resolvePath(params.workspaceRoot));
    const query = params.query?.trim().toLowerCase();
    const kind = params.kind?.trim().toLowerCase();
    const language = params.language?.trim().toLowerCase();
    const filtered = index.symbols.filter((symbol) => {
      if (language && symbol.language !== language) return false;
      if (kind && symbol.kind !== kind) return false;
      if (!query) return true;
      const name = symbol.name.toLowerCase();
      const signature = symbol.signature?.toLowerCase() ?? "";
      return name.includes(query) || signature.includes(query);
    });
    filtered.sort((left, right) => {
      const leftScore = query
        ? left.name.toLowerCase() === query
          ? 0
          : left.name.toLowerCase().startsWith(query)
            ? 1
            : 2
        : 0;
      const rightScore = query
        ? right.name.toLowerCase() === query
          ? 0
          : right.name.toLowerCase().startsWith(query)
            ? 1
            : 2
        : 0;
      if (leftScore !== rightScore) return leftScore - rightScore;
      if (left.name !== right.name) return left.name.localeCompare(right.name);
      return left.filePath.localeCompare(right.filePath);
    });
    return filtered.slice(0, Math.max(1, Math.min(params.maxResults ?? 50, 200)));
  }

  async getDefinition(params: {
    readonly workspaceRoot: string;
    readonly symbolName: string;
    readonly filePath?: string;
  }): Promise<CodeIntelSymbol | undefined> {
    const index = await this.buildIndex(resolvePath(params.workspaceRoot));
    const symbolName = params.symbolName.trim();
    const filePath = params.filePath ? resolvePath(params.filePath) : undefined;
    return index.symbols.find((symbol) =>
      symbol.name === symbolName &&
      (filePath ? symbol.filePath === filePath : true)
    );
  }

  async getReferences(params: {
    readonly workspaceRoot: string;
    readonly symbolName: string;
    readonly filePath?: string;
    readonly maxResults?: number;
  }): Promise<
    readonly {
      filePath: string;
      line: number;
      column: number;
      lineText: string;
    }[]
  > {
    const workspaceRoot = resolvePath(params.workspaceRoot);
    const files = await listCandidateFiles(workspaceRoot);
    const pattern = new RegExp(`\\b${escapeRegExp(params.symbolName.trim())}\\b`);
    const references: {
      filePath: string;
      line: number;
      column: number;
      lineText: string;
    }[] = [];
    for (const filePath of files) {
      if (params.filePath && resolvePath(params.filePath) !== filePath) {
        continue;
      }
      const raw = await readFile(filePath, "utf8").catch(() => "");
      if (!raw) continue;
      const lines = raw.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        const match = pattern.exec(line);
        if (!match || match.index < 0) continue;
        references.push({
          filePath,
          line: index + 1,
          column: match.index + 1,
          lineText: line.trim(),
        });
        if (references.length >= Math.max(1, Math.min(params.maxResults ?? 100, 500))) {
          return references;
        }
      }
    }
    return references;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function collectWorkspaceLanguages(
  workspaceRoot: string,
): Promise<Record<string, number>> {
  const files = await listCandidateFiles(workspaceRoot);
  const counts = new Map<string, number>();
  for (const filePath of files) {
    const language = detectLanguage(filePath);
    if (!language) continue;
    counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  return Object.fromEntries(
    [...counts.entries()].sort((left, right) => right[1] - left[1]),
  );
}

export async function collectWorkspaceFiles(
  workspaceRoot: string,
): Promise<readonly string[]> {
  return listCandidateFiles(workspaceRoot);
}

export function toRelativeWorkspacePath(
  workspaceRoot: string,
  filePath: string,
): string {
  return relative(resolvePath(workspaceRoot), resolvePath(filePath)) || basename(filePath);
}
