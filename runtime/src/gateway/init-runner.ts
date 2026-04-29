import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { constants } from "node:fs";
import { access, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import type { ChatExecutorResult } from "../llm/chat-executor-types.js";

const INIT_GUIDE_FILENAME = "AGENC.md";
const MAX_FILE_EXCERPT_CHARS = 4_000;
const MAX_ROOT_ENTRIES = 60;
const MAX_SUBDIRECTORY_SAMPLES = 5;
const MAX_SUBDIRECTORY_ENTRY_NAMES = 16;
const REQUIRED_SECTION_HEADINGS = [
  "## Project Structure & Module Organization",
  "## Build, Test, and Development Commands",
  "## Coding Style & Naming Conventions",
  "## Testing Guidelines",
  "## Commit & Pull Request Guidelines",
] as const;

interface ModelBackedProjectGuideParams {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly force?: boolean;
  readonly minimumDelegatedInvestigations?: number;
  readonly onProgress?: (event: {
    readonly stage:
      | "start"
      | "evidence_collected"
      | "guide_synthesized"
      | "file_written";
    readonly workspaceRoot: string;
    readonly filePath: string;
    readonly attempt?: number;
    readonly detail?: string;
  }) => void;
}

interface ModelBackedProjectGuideResult {
  readonly status: "created" | "updated" | "skipped";
  readonly filePath: string;
  readonly content: string;
  readonly attempts: number;
  readonly delegatedInvestigations: number;
  readonly result: ChatExecutorResult | null;
}

interface InitEvidenceFile {
  readonly path: string;
  readonly content: string;
}

interface InitSubdirectorySample {
  readonly path: string;
  readonly entries: readonly string[];
}

interface InitEvidenceBundle {
  readonly rootEntries: readonly string[];
  readonly keyFiles: readonly InitEvidenceFile[];
  readonly subdirectories: readonly InitSubdirectorySample[];
  readonly recentCommitSubjects: readonly string[];
}

const execFile = promisify(execFileCallback);

const KEY_FILE_PATTERNS = [
  /^readme(?:\..+)?$/i,
  /^package\.json$/i,
  /^cargo\.toml$/i,
  /^cargo\.lock$/i,
  /^cmakelists\.txt$/i,
  /^makefile$/i,
  /^pyproject\.toml$/i,
  /^requirements(?:\..+)?\.txt$/i,
  /^go\.mod$/i,
  /^go\.sum$/i,
  /^composer\.json$/i,
  /^gemfile$/i,
  /^deno\.json(?:c)?$/i,
  /^tsconfig(?:\..+)?\.json$/i,
  /^vitest\.config\..+$/i,
  /^jest\.config\..+$/i,
  /^playwright\.config\..+$/i,
  /^vite\.config\..+$/i,
  /^claude\.md$/i,
  /^agents\.md$/i,
  // Generic planning/spec markdown files at the repo root. Replaces a
  // hard-coded `^plan\.md$` pattern that special-cased a single filename.
  // Anything matching `*.md` at the root that is not README/CLAUDE/AGENTS
  // will be picked up as a candidate planning document and filtered
  // downstream in synthesizeInitGuide.
  /^[A-Za-z0-9._-]+\.md$/i,
] as const;

const STRUCTURE_DIR_PATTERNS = [
  /^src$/i,
  /^app$/i,
  /^lib$/i,
  /^runtime$/i,
  /^tests?$/i,
  /^docs?$/i,
  /^examples?$/i,
  /^scripts?$/i,
  /^packages?$/i,
  /^crates?$/i,
  /^programs?$/i,
] as const;

export function resolveInitGuidePath(workspaceRoot: string): string {
  return join(resolvePath(workspaceRoot), INIT_GUIDE_FILENAME);
}

export function validateInitGuideContent(content: string): string | null {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return "AGENC.md was empty";
  }
  if (!trimmed.startsWith("# Repository Guidelines")) {
    return 'AGENC.md must start with "# Repository Guidelines"';
  }
  for (const heading of REQUIRED_SECTION_HEADINGS) {
    if (!trimmed.includes(heading)) {
      return `AGENC.md is missing required section "${heading}"`;
    }
  }
  return null;
}

export function buildModelBackedInitPrompt(params: {
  readonly workspaceRoot: string;
  readonly filePath: string;
  readonly force: boolean;
  readonly minimumDelegatedInvestigations: number;
  readonly evidence: InitEvidenceBundle;
  readonly retryReason?: string;
}): string {
  const retryInstruction =
    typeof params.retryReason === "string" && params.retryReason.trim().length > 0
      ? `\nPrevious attempt failed validation: ${params.retryReason.trim()}\nRetry from scratch and fix that exact problem.`
      : "";
  const overwriteInstruction = params.force
    ? "Overwrite the existing AGENC.md if it already exists."
    : "Create AGENC.md if it does not already exist.";
  const rootEntriesSummary =
    params.evidence.rootEntries.length > 0
      ? params.evidence.rootEntries.map((entry) => `- ${entry}`).join("\n")
      : "- No visible root entries were discovered.";
  const keyFileSummary =
    params.evidence.keyFiles.length > 0
      ? params.evidence.keyFiles
          .map(
            (file) =>
              `### ${file.path}\n\`\`\`\n${file.content.trim()}\n\`\`\``,
          )
          .join("\n\n")
      : "No key files were readable.";
  const subdirectorySummary =
    params.evidence.subdirectories.length > 0
      ? params.evidence.subdirectories
          .map(
            (sample) =>
              `- ${sample.path}: ${sample.entries.length > 0 ? sample.entries.join(", ") : "(empty)"}`,
          )
          .join("\n")
      : "- No subdirectory samples were collected.";
  const commitSummary =
    params.evidence.recentCommitSubjects.length > 0
      ? params.evidence.recentCommitSubjects.map((subject) => `- ${subject}`).join("\n")
      : "- Git history unavailable or empty.";

  return [
    `Generate ${params.filePath} for the repository at ${params.workspaceRoot}.`,
    overwriteInstruction,
    "",
    "The document must:",
    '- Start with "# Repository Guidelines".',
    `- Include these section headings:\n  ${REQUIRED_SECTION_HEADINGS.join("\n  ")}`,
    "- Be concise and specific to what you actually found in the repo.",
    "- Return only the Markdown document. Do not wrap it in code fences.",
    "- Distinguish existing structure from planned structure. When a planning or specification file describes intended files that are not yet present, describe them as planned, not already present.",
    "",
    "Use only the grounded repository evidence below. Do not invent files, commands, tests, or conventions that are not supported by this evidence.",
    "",
    "Root entries:",
    rootEntriesSummary,
    "",
    "Key file excerpts:",
    keyFileSummary,
    "",
    "Subdirectory samples:",
    subdirectorySummary,
    "",
    "Recent commit subjects:",
    commitSummary,
    retryInstruction,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readFileIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

function normalizeInitGuideDraft(content: string): string {
  let trimmed = content.trim();
  const headingIndex = trimmed.indexOf("# Repository Guidelines");
  if (headingIndex >= 0) {
    trimmed = trimmed.slice(headingIndex).trim();
  }
  if (trimmed.startsWith("```")) {
    const lines = trimmed.split("\n");
    if (lines.length >= 3 && lines.at(-1)?.trim() === "```") {
      trimmed = lines.slice(1, -1).join("\n").trim();
    }
  }
  return trimmed;
}

function bulletList(items: readonly string[]): string[] {
  return items.length > 0 ? items.map((item) => `- ${item}`) : ["- None detected."];
}

function extractPlannedStructure(planContent: string | undefined): readonly string[] {
  if (!planContent) return [];
  const codeBlockMatches = [...planContent.matchAll(/```[\w-]*\n([\s\S]*?)\n```/g)];
  const fromCodeBlocks = codeBlockMatches.flatMap((match) =>
    match[1]
      .split("\n")
      .map((line) => line.replace(/^[│├└─\s]+/, "").trim())
      .filter((line) => line.length > 0)
      .filter((line) => /[A-Za-z0-9]/.test(line))
      .filter((line) => line !== "-"),
  );
  const fallbackMatches = [...planContent.matchAll(
    /(?:^|\n)(?:[├└│─ ]+)?([A-Za-z0-9._-]+(?:\/|(?:\.[A-Za-z0-9_-]+)?))/g,
  )]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value))
    .filter((value) => /[A-Za-z0-9]/.test(value))
    .filter((value) => value !== "-");

  const rawMatches = fromCodeBlocks.length > 0 ? fromCodeBlocks : fallbackMatches;
  const uniqueMatches = Array.from(
    new Set(
      rawMatches
        .filter((value) => value !== INIT_GUIDE_FILENAME)
        .filter((value) => value !== "```"),
    ),
  );

  if (uniqueMatches.length > 1) {
    const [first, ...rest] = uniqueMatches;
    if (
      typeof first === "string" &&
      first.endsWith("/") &&
      !first.includes("./") &&
      !first.includes("../") &&
      !rest.some((entry) => entry === first)
    ) {
      return rest.slice(0, 12);
    }
  }

  return uniqueMatches.slice(0, 12);
}

function extractPackageJsonScripts(content: string | undefined): readonly string[] {
  if (!content) return [];
  try {
    const parsed = JSON.parse(content) as {
      scripts?: Record<string, string>;
    };
    return Object.entries(parsed.scripts ?? {}).map(
      ([name, command]) => `npm run ${name}  # ${command}`,
    );
  } catch {
    return [];
  }
}

function synthesizeInitGuide(params: {
  readonly workspaceRoot: string;
  readonly evidence: InitEvidenceBundle;
}): string {
  const readme = params.evidence.keyFiles.find((file) => /^readme(?:\..+)?$/i.test(file.path));
  const packageJson = params.evidence.keyFiles.find((file) => file.path === "package.json");
  const cargoToml = params.evidence.keyFiles.find((file) => file.path === "Cargo.toml");
  const cmakeLists = params.evidence.keyFiles.find((file) => file.path === "CMakeLists.txt");
  const makefile = params.evidence.keyFiles.find((file) => /^Makefile$/i.test(file.path));
  const claude = params.evidence.keyFiles.find((file) => /^CLAUDE\.md$/i.test(file.path));
  const agents = params.evidence.keyFiles.find((file) => /^AGENTS\.md$/i.test(file.path));
  // Markdown files at the repo root that look like planning/spec documents,
  // generically. Discovered by extension, not by a hard-coded filename —
  // runtime behavior must not depend on any particular filename.
  const planningDocs = params.evidence.keyFiles.filter(
    (file) =>
      /\.md$/i.test(file.path) &&
      !/^readme(?:\..+)?$/i.test(file.path) &&
      !/^claude\.md$/i.test(file.path) &&
      !/^agents\.md$/i.test(file.path),
  );

  const structureLines = [
    ...(
      params.evidence.rootEntries.length > 0
        ? params.evidence.rootEntries.map((entry) =>
            entry.endsWith("/")
              ? `${entry} exists at the repository root.`
              : `${entry} exists at the repository root.`,
          )
        : ["No visible repository entries were discovered at the root."]
    ),
    ...(params.evidence.subdirectories.length > 0
      ? params.evidence.subdirectories.map(
          (sample) =>
            `${sample.path} currently contains ${sample.entries.length > 0 ? sample.entries.join(", ") : "no sampled entries"}.`,
        )
      : []),
  ];
  for (const doc of planningDocs) {
    const planned = extractPlannedStructure(doc.content);
    if (planned.length > 0) {
      structureLines.push(
        `${doc.path} describes planned future structure including ${planned.join(", ")}; those paths are not all present yet.`,
      );
    }
  }

  const buildLines: string[] = [];
  buildLines.push(...extractPackageJsonScripts(packageJson?.content));
  if (cargoToml) {
    buildLines.push("cargo build");
    buildLines.push("cargo test");
  }
  if (cmakeLists) {
    buildLines.push("cmake -S . -B build");
    buildLines.push("cmake --build build");
  }
  if (makefile) {
    buildLines.push("make");
  }
  if (buildLines.length === 0) {
    buildLines.push("No executable build or test commands were discovered from the current repository contents.");
  }

  const styleLines: string[] = [];
  if (claude) {
    styleLines.push("CLAUDE.md defines repository-specific working and review rules; follow those rules when modifying this repo.");
  }
  if (agents) {
    styleLines.push("AGENTS.md is present and should be treated as an additional local instruction source.");
  }
  if (styleLines.length === 0) {
    styleLines.push("No explicit coding-style document was discovered in the current repository contents.");
  }

  const testingLines: string[] = [];
  if (packageJson?.content) {
    const packageScripts = extractPackageJsonScripts(packageJson.content).filter((line) =>
      /\bnpm run test\b/.test(line),
    );
    testingLines.push(...packageScripts);
  }
  if (cargoToml) {
    testingLines.push("cargo test");
  }
  if (testingLines.length === 0) {
    testingLines.push("No runnable test command was discovered from the current repository contents.");
  }

  const commitLines =
    params.evidence.recentCommitSubjects.length > 0
      ? params.evidence.recentCommitSubjects.map(
          (subject) => `Recent commit subject: ${subject}`,
        )
      : [
          "No git history was available from this directory, so local commit and PR conventions could not be inferred from recent commits.",
        ];

  const intro =
    readme?.content?.split("\n").find((line) => line.trim().length > 0) ??
    "This repository currently has minimal on-disk structure.";

  return [
    "# Repository Guidelines",
    "",
    intro,
    "",
    "## Project Structure & Module Organization",
    ...bulletList(structureLines),
    "",
    "## Build, Test, and Development Commands",
    ...bulletList(buildLines),
    "",
    "## Coding Style & Naming Conventions",
    ...bulletList(styleLines),
    "",
    "## Testing Guidelines",
    ...bulletList(testingLines),
    "",
    "## Commit & Pull Request Guidelines",
    ...bulletList(commitLines),
  ].join("\n");
}

function shouldReadAsEvidence(name: string): boolean {
  return KEY_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

function shouldSampleSubdirectory(name: string): boolean {
  return STRUCTURE_DIR_PATTERNS.some((pattern) => pattern.test(name));
}

async function safeReadTextExcerpt(path: string): Promise<string | null> {
  try {
    const fileStats = await stat(path);
    if (!fileStats.isFile() || fileStats.size === 0) {
      return null;
    }
    const content = await readFile(path, "utf-8");
    const trimmed = content.trim();
    if (trimmed.length === 0) {
      return null;
    }
    return trimmed.slice(0, MAX_FILE_EXCERPT_CHARS);
  } catch {
    return null;
  }
}

async function collectInitEvidence(
  workspaceRoot: string,
): Promise<InitEvidenceBundle> {
  const rootEntries = await readdir(workspaceRoot, {
    withFileTypes: true,
  });
  rootEntries.sort((left, right) => left.name.localeCompare(right.name));

  const rootEntrySummary = rootEntries
    .slice(0, MAX_ROOT_ENTRIES)
    .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`);

  const keyFiles: InitEvidenceFile[] = [];
  for (const entry of rootEntries) {
    if (!entry.isFile() || !shouldReadAsEvidence(entry.name)) {
      continue;
    }
    if (entry.name === INIT_GUIDE_FILENAME) {
      continue;
    }
    const fullPath = join(workspaceRoot, entry.name);
    const content = await safeReadTextExcerpt(fullPath);
    if (!content) {
      continue;
    }
    keyFiles.push({ path: entry.name, content });
  }

  const subdirectories: InitSubdirectorySample[] = [];
  for (const entry of rootEntries) {
    if (!entry.isDirectory() || !shouldSampleSubdirectory(entry.name)) {
      continue;
    }
    if (subdirectories.length >= MAX_SUBDIRECTORY_SAMPLES) {
      break;
    }
    try {
      const children = await readdir(join(workspaceRoot, entry.name), {
        withFileTypes: true,
      });
      children.sort((left, right) => left.name.localeCompare(right.name));
      subdirectories.push({
        path: `${entry.name}/`,
        entries: children
          .slice(0, MAX_SUBDIRECTORY_ENTRY_NAMES)
          .map((child) => `${child.name}${child.isDirectory() ? "/" : ""}`),
      });
    } catch {
      // Ignore unreadable directories; the evidence bundle should degrade gracefully.
    }
  }

  let recentCommitSubjects: string[] = [];
  try {
    const { stdout } = await execFile("git", [
      "-C",
      workspaceRoot,
      "log",
      "-5",
      "--pretty=format:%s",
    ]);
    recentCommitSubjects = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    recentCommitSubjects = [];
  }

  return {
    rootEntries: rootEntrySummary,
    keyFiles,
    subdirectories,
    recentCommitSubjects,
  };
}

export async function runModelBackedProjectGuide(
  params: ModelBackedProjectGuideParams,
): Promise<ModelBackedProjectGuideResult> {
  const workspaceRoot = resolvePath(params.workspaceRoot);
  const filePath = resolveInitGuidePath(workspaceRoot);
  const force = params.force === true;
  const existedBefore = await fileExists(filePath);

  if (existedBefore && !force) {
    const existingContent = (await readFileIfExists(filePath)) ?? "";
    return {
      status: "skipped",
      filePath,
      content: existingContent,
      attempts: 0,
      delegatedInvestigations: 0,
      result: null,
    };
  }

  params.onProgress?.({
    stage: "start",
    workspaceRoot,
    filePath,
  });
  const evidence = await collectInitEvidence(workspaceRoot);
  params.onProgress?.({
    stage: "evidence_collected",
    workspaceRoot,
    filePath,
    detail: `rootEntries=${evidence.rootEntries.length},keyFiles=${evidence.keyFiles.length},subdirectories=${evidence.subdirectories.length},recentCommits=${evidence.recentCommitSubjects.length}`,
  });
  const synthesized = normalizeInitGuideDraft(
    synthesizeInitGuide({ workspaceRoot, evidence }),
  );
  params.onProgress?.({
    stage: "guide_synthesized",
    workspaceRoot,
    filePath,
    attempt: 1,
    detail: `contentChars=${synthesized.length}`,
  });
  const failureReason = validateInitGuideContent(synthesized);
  if (failureReason) {
    throw new Error(
      `Deterministic init synthesis failed validation for ${filePath}: ${failureReason}`,
    );
  }
  await writeFile(filePath, `${synthesized}\n`, "utf-8");
  params.onProgress?.({
    stage: "file_written",
    workspaceRoot,
    filePath,
    attempt: 1,
    detail: `contentChars=${synthesized.length}`,
  });
  return {
    status: existedBefore ? "updated" : "created",
    filePath,
    content: synthesized,
    attempts: 1,
    delegatedInvestigations: 0,
    result: null,
  };
}
