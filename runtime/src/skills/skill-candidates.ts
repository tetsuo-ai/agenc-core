/**
 * Self-authored skill candidates: drafts the runtime proposes, the user accepts.
 *
 * The memory-extraction child (services/extractMemories) already reviews a
 * finished stretch of conversation. This module gives that same run one more
 * thing to look for: a procedure that was carried out and then checked, worth
 * keeping as a skill. The child answers with a fenced `skill-candidates` block
 * at the end of its final reply; the parent parses that block here, validates
 * every entry, and writes each survivor as a DRAFT under
 * `<AGENC_HOME>/skill-candidates/<slug>/` (SKILL.md plus candidate.json) with
 * one line appended to `<AGENC_HOME>/skill-candidates/ledger.jsonl`.
 *
 * A draft is inert. The local loader (local-loader.ts) discovers skills only
 * from fixed roots (`<dir>/.agenc/skills` and `<dir>/.agents/skills` on the
 * project walk, `<AGENC_HOME>/skills`, `$HOME/.agents/skills`,
 * `$AGENC_MANAGED_HOME/.agenc/skills`, and plugin skill roots) and walks
 * downward from each of them. `<AGENC_HOME>/skill-candidates` is a sibling of
 * `<AGENC_HOME>/skills`, never a root and never below one, so nothing written
 * here reaches the listing, the command catalog, or the model until
 * `agenc skills candidates accept <slug>` moves the directory into
 * `<AGENC_HOME>/skills/<slug>/`.
 *
 * Everything the child says is untrusted conversation output: names are
 * validated against a strict slug grammar before they become a path, bodies
 * are capped, and the memory secrets scan runs over every text field.
 */

import {
  appendFile,
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { scanForSecrets } from "../memory/index.js";
import { isEnvDefinedFalsy } from "../utils/envBoolean.js";

/** Sibling of `<AGENC_HOME>/skills`; never a skills root. */
export const SKILL_CANDIDATES_DIR_NAME = "skill-candidates";
export const SKILL_CANDIDATES_LEDGER_FILE = "ledger.jsonl";
export const SKILL_CANDIDATE_RECORD_FILE = "candidate.json";
export const SKILL_CANDIDATE_SKILL_FILE = "SKILL.md";
/** Info string of the fenced block the extraction child answers with. */
export const SKILL_CANDIDATE_BLOCK_TAG = "skill-candidates";
/** `AGENC_SKILL_CANDIDATES=0` switches proposals off. */
export const SKILL_CANDIDATES_ENV = "AGENC_SKILL_CANDIDATES";
export const MAX_SKILL_CANDIDATES_PER_RUN = 2;
export const MAX_SKILL_CANDIDATE_BODY_BYTES = 16 * 1024;
export const MAX_SKILL_CANDIDATE_EVIDENCE = 8;
const MAX_ONE_LINE_LENGTH = 300;
const MIN_SLUG_LENGTH = 3;
const MAX_SLUG_LENGTH = 64;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const FENCED_BLOCK_PATTERN = new RegExp(
  "^[ \\t]*```" +
    SKILL_CANDIDATE_BLOCK_TAG +
    "[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n[ \\t]*```[ \\t]*$",
  "gmu",
);

export interface SkillCandidateProposal {
  /** Kebab-case skill name; also the directory slug. */
  readonly name: string;
  readonly description: string;
  readonly whenToUse: string;
  /** SKILL.md markdown body (purpose, steps, verification, pitfalls). */
  readonly body: string;
  /** What in the conversation showed the procedure. */
  readonly evidence: readonly string[];
}

export interface SkillCandidateProvenance {
  readonly sessionId?: string;
  readonly conversationId?: string;
  readonly createdAt: string;
  readonly model?: string;
}

/** Contents of `<slug>/candidate.json`. */
export interface SkillCandidateRecord {
  readonly schemaVersion: 1;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly whenToUse: string;
  readonly evidence: readonly string[];
  readonly provenance: SkillCandidateProvenance;
}

export type SkillCandidateLedgerAction = "proposed" | "accepted" | "rejected";

export interface SkillCandidateLedgerEntry {
  readonly slug: string;
  readonly action: SkillCandidateLedgerAction;
  readonly at: string;
  readonly sessionId?: string;
}

export interface SkillCandidateParseResult {
  readonly candidates: readonly SkillCandidateProposal[];
  /** Why an entry was dropped, one line each, for the session log. */
  readonly dropped: readonly string[];
}

export type SkillCandidateValidation =
  | { readonly ok: true; readonly candidate: SkillCandidateProposal }
  | { readonly ok: false; readonly reason: string };

export type SkillCandidateErrorCode = "invalid_slug" | "not_found" | "name_taken";

export class SkillCandidateError extends Error {
  readonly name = "SkillCandidateError";

  constructor(
    readonly code: SkillCandidateErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function isSkillCandidatesDisabledByEnv(
  env: Readonly<Record<string, string | undefined>> | undefined,
): boolean {
  return isEnvDefinedFalsy((env ?? process.env)[SKILL_CANDIDATES_ENV]);
}

export function isValidSkillCandidateSlug(value: string): boolean {
  return (
    value.length >= MIN_SLUG_LENGTH &&
    value.length <= MAX_SLUG_LENGTH &&
    SLUG_PATTERN.test(value)
  );
}

export function resolveSkillCandidatesRoot(agencHome: string): string {
  return join(agencHome, SKILL_CANDIDATES_DIR_NAME);
}

export function resolveSkillCandidateDirectory(
  agencHome: string,
  slug: string,
): string {
  assertSlug(slug);
  return join(resolveSkillCandidatesRoot(agencHome), slug);
}

function assertSlug(slug: string): void {
  if (!isValidSkillCandidateSlug(slug)) {
    throw new SkillCandidateError(
      "invalid_slug",
      `skill candidate names are kebab-case (letters, digits, single hyphens, ${MIN_SLUG_LENGTH} to ${MAX_SLUG_LENGTH} characters): ${JSON.stringify(slug)}`,
    );
  }
}

function oneLine(value: unknown, field: string): string | { readonly reason: string } {
  if (typeof value !== "string") return { reason: `${field} is not a string` };
  const trimmed = value.trim();
  if (trimmed.length === 0) return { reason: `${field} is empty` };
  if (/[\r\n]/u.test(trimmed)) return { reason: `${field} must be one line` };
  if (trimmed.length > MAX_ONE_LINE_LENGTH) {
    return { reason: `${field} is longer than ${MAX_ONE_LINE_LENGTH} characters` };
  }
  return trimmed;
}

function isReason(value: unknown): value is { readonly reason: string } {
  return typeof value === "object" && value !== null && "reason" in value;
}

/** A body that arrives with its own frontmatter would double the header. */
function stripLeadingFrontmatter(body: string): string {
  const match = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/u.exec(body);
  return match ? body.slice(match[0].length) : body;
}

/**
 * Shape and content check for one proposed entry. The secrets scan covers
 * every text field because the child read the whole conversation, tool output
 * included, and a token it saw there must not land in a draft on disk.
 */
export function validateSkillCandidateProposal(
  raw: unknown,
): SkillCandidateValidation {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "entry is not an object" };
  }
  const record = raw as Record<string, unknown>;
  const label =
    typeof record.name === "string" && record.name.length > 0
      ? record.name
      : "<unnamed>";
  if (typeof record.name !== "string" || !isValidSkillCandidateSlug(record.name)) {
    return {
      ok: false,
      reason: `${label}: name is not a kebab-case slug of ${MIN_SLUG_LENGTH} to ${MAX_SLUG_LENGTH} characters`,
    };
  }
  const description = oneLine(record.description, "description");
  if (isReason(description)) return { ok: false, reason: `${label}: ${description.reason}` };
  const whenToUse = oneLine(record.whenToUse, "whenToUse");
  if (isReason(whenToUse)) return { ok: false, reason: `${label}: ${whenToUse.reason}` };
  if (typeof record.body !== "string") {
    return { ok: false, reason: `${label}: body is not a string` };
  }
  const body = stripLeadingFrontmatter(record.body).trim();
  if (body.length === 0) return { ok: false, reason: `${label}: body is empty` };
  const bodyBytes = Buffer.byteLength(body, "utf8");
  if (bodyBytes > MAX_SKILL_CANDIDATE_BODY_BYTES) {
    return {
      ok: false,
      reason: `${label}: body is ${bodyBytes} bytes, the cap is ${MAX_SKILL_CANDIDATE_BODY_BYTES}`,
    };
  }
  if (!Array.isArray(record.evidence) || record.evidence.length === 0) {
    return { ok: false, reason: `${label}: evidence is missing` };
  }
  const evidence: string[] = [];
  for (const item of record.evidence.slice(0, MAX_SKILL_CANDIDATE_EVIDENCE)) {
    const line = oneLine(item, "evidence item");
    if (isReason(line)) return { ok: false, reason: `${label}: ${line.reason}` };
    evidence.push(line);
  }
  const secrets = scanForSecrets(
    [description, whenToUse, body, ...evidence].join("\n"),
  );
  if (secrets.length > 0) {
    return {
      ok: false,
      reason: `${label}: content contains potential secrets (${secrets.map((match) => match.label).join(", ")})`,
    };
  }
  return {
    ok: true,
    candidate: {
      name: record.name,
      description,
      whenToUse,
      body,
      evidence,
    },
  };
}

/**
 * The proposals in a child's final reply: every fenced `skill-candidates`
 * block, parsed as `{ "skillCandidates": [...] }` or a bare array. Entries
 * past the per-run cap and entries that fail validation are dropped with a
 * reason; a malformed block drops as a whole. No block means no proposal.
 */
export function parseSkillCandidateProposals(
  finalMessage: string | undefined,
): SkillCandidateParseResult {
  const candidates: SkillCandidateProposal[] = [];
  const dropped: string[] = [];
  if (typeof finalMessage !== "string" || finalMessage.length === 0) {
    return { candidates, dropped };
  }
  const seen = new Set<string>();
  for (const match of finalMessage.matchAll(FENCED_BLOCK_PATTERN)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1] ?? "");
    } catch (error) {
      dropped.push(
        `skill-candidates block is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    const entries = Array.isArray(parsed)
      ? parsed
      : typeof parsed === "object" &&
          parsed !== null &&
          Array.isArray((parsed as { skillCandidates?: unknown }).skillCandidates)
        ? ((parsed as { skillCandidates: unknown[] }).skillCandidates)
        : null;
    if (entries === null) {
      dropped.push(
        "skill-candidates block is neither an array nor an object with a skillCandidates array",
      );
      continue;
    }
    for (const entry of entries) {
      const validation = validateSkillCandidateProposal(entry);
      if (!validation.ok) {
        dropped.push(validation.reason);
        continue;
      }
      if (seen.has(validation.candidate.name)) {
        dropped.push(`${validation.candidate.name}: proposed twice in one run`);
        continue;
      }
      if (candidates.length >= MAX_SKILL_CANDIDATES_PER_RUN) {
        dropped.push(
          `${validation.candidate.name}: over the per-run cap of ${MAX_SKILL_CANDIDATES_PER_RUN}`,
        );
        continue;
      }
      seen.add(validation.candidate.name);
      candidates.push(validation.candidate);
    }
  }
  return { candidates, dropped };
}

/** YAML double-quoted scalar; JSON string escaping is valid YAML. */
function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

/** The SKILL.md a candidate becomes: loader frontmatter plus the body as given. */
export function renderSkillCandidateFile(candidate: SkillCandidateProposal): string {
  return [
    "---",
    `name: ${yamlScalar(candidate.name)}`,
    `description: ${yamlScalar(candidate.description)}`,
    `when_to_use: ${yamlScalar(candidate.whenToUse)}`,
    "---",
    "",
    candidate.body.trim(),
    "",
  ].join("\n");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function appendLedger(
  agencHome: string,
  entry: SkillCandidateLedgerEntry,
): Promise<void> {
  const root = resolveSkillCandidatesRoot(agencHome);
  await mkdir(root, { recursive: true });
  await appendFile(
    join(root, SKILL_CANDIDATES_LEDGER_FILE),
    `${JSON.stringify(entry)}\n`,
    "utf8",
  );
}

/** Every ledger line that parses, oldest first. */
export async function readSkillCandidateLedger(
  agencHome: string,
): Promise<readonly SkillCandidateLedgerEntry[]> {
  let raw: string;
  try {
    raw = await readFile(
      join(resolveSkillCandidatesRoot(agencHome), SKILL_CANDIDATES_LEDGER_FILE),
      "utf8",
    );
  } catch {
    return [];
  }
  const entries: SkillCandidateLedgerEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as Partial<SkillCandidateLedgerEntry>;
      if (
        typeof parsed.slug === "string" &&
        typeof parsed.action === "string" &&
        typeof parsed.at === "string"
      ) {
        entries.push(parsed as SkillCandidateLedgerEntry);
      }
    } catch {
      // A torn line from an interrupted append is skipped, not fatal.
    }
  }
  return entries;
}

export interface WriteSkillCandidatesOptions {
  readonly agencHome: string;
  readonly candidates: readonly SkillCandidateProposal[];
  /** Names that already resolve to a skill; a proposal with one is skipped. */
  readonly installedSkillNames: Iterable<string>;
  readonly provenance: Omit<SkillCandidateProvenance, "createdAt"> & {
    readonly createdAt?: string;
  };
}

export interface WrittenSkillCandidate {
  readonly slug: string;
  readonly path: string;
}

export interface SkippedSkillCandidate {
  readonly slug: string;
  readonly reason: string;
}

export interface WriteSkillCandidatesResult {
  readonly written: readonly WrittenSkillCandidate[];
  readonly skipped: readonly SkippedSkillCandidate[];
}

/**
 * Write validated proposals as drafts. A name that is already an installed
 * skill or an existing draft is skipped and reported, never overwritten.
 */
export async function writeSkillCandidates(
  options: WriteSkillCandidatesOptions,
): Promise<WriteSkillCandidatesResult> {
  const installed = new Set(options.installedSkillNames);
  const written: WrittenSkillCandidate[] = [];
  const skipped: SkippedSkillCandidate[] = [];
  const createdAt = options.provenance.createdAt ?? new Date().toISOString();
  for (const candidate of options.candidates) {
    const slug = candidate.name;
    if (!isValidSkillCandidateSlug(slug)) {
      skipped.push({ slug, reason: "name is not a valid slug" });
      continue;
    }
    if (installed.has(slug)) {
      skipped.push({ slug, reason: "a skill with this name is already installed" });
      continue;
    }
    const directory = resolveSkillCandidateDirectory(options.agencHome, slug);
    if (await pathExists(directory)) {
      skipped.push({ slug, reason: "a candidate with this name already exists" });
      continue;
    }
    const record: SkillCandidateRecord = {
      schemaVersion: 1,
      slug,
      name: candidate.name,
      description: candidate.description,
      whenToUse: candidate.whenToUse,
      evidence: candidate.evidence,
      provenance: {
        ...(options.provenance.sessionId !== undefined
          ? { sessionId: options.provenance.sessionId }
          : {}),
        ...(options.provenance.conversationId !== undefined
          ? { conversationId: options.provenance.conversationId }
          : {}),
        createdAt,
        ...(options.provenance.model !== undefined
          ? { model: options.provenance.model }
          : {}),
      },
    };
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, SKILL_CANDIDATE_SKILL_FILE),
      renderSkillCandidateFile(candidate),
      "utf8",
    );
    await writeFile(
      join(directory, SKILL_CANDIDATE_RECORD_FILE),
      `${JSON.stringify(record, null, 2)}\n`,
      "utf8",
    );
    await appendLedger(options.agencHome, {
      slug,
      action: "proposed",
      at: createdAt,
      ...(options.provenance.sessionId !== undefined
        ? { sessionId: options.provenance.sessionId }
        : {}),
    });
    written.push({ slug, path: directory });
  }
  return { written, skipped };
}

export interface SkillCandidateSummary {
  readonly slug: string;
  readonly description: string;
  readonly whenToUse?: string;
  readonly createdAt?: string;
  readonly evidenceCount: number;
  readonly path: string;
}

export interface SkillCandidateListing {
  readonly candidates: readonly SkillCandidateSummary[];
  readonly errors: readonly string[];
}

/** Every draft directory that holds a SKILL.md, sorted by slug. */
export async function listSkillCandidates(
  agencHome: string,
): Promise<SkillCandidateListing> {
  const root = resolveSkillCandidatesRoot(agencHome);
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return { candidates: [], errors: [] };
  }
  const candidates: SkillCandidateSummary[] = [];
  const errors: string[] = [];
  for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || !isValidSkillCandidateSlug(entry.name)) continue;
    const directory = join(root, entry.name);
    if (!(await pathExists(join(directory, SKILL_CANDIDATE_SKILL_FILE)))) continue;
    let record: Partial<SkillCandidateRecord> = {};
    try {
      record = JSON.parse(
        await readFile(join(directory, SKILL_CANDIDATE_RECORD_FILE), "utf8"),
      ) as Partial<SkillCandidateRecord>;
    } catch (error) {
      errors.push(
        `${entry.name}: ${SKILL_CANDIDATE_RECORD_FILE} unreadable (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    candidates.push({
      slug: entry.name,
      description: typeof record.description === "string" ? record.description : "",
      ...(typeof record.whenToUse === "string" ? { whenToUse: record.whenToUse } : {}),
      ...(typeof record.provenance?.createdAt === "string"
        ? { createdAt: record.provenance.createdAt }
        : {}),
      evidenceCount: Array.isArray(record.evidence) ? record.evidence.length : 0,
      path: directory,
    });
  }
  return { candidates, errors };
}

/** The draft's SKILL.md text. */
export async function readSkillCandidateFile(
  agencHome: string,
  slug: string,
): Promise<string> {
  const directory = resolveSkillCandidateDirectory(agencHome, slug);
  try {
    return await readFile(join(directory, SKILL_CANDIDATE_SKILL_FILE), "utf8");
  } catch {
    throw new SkillCandidateError("not_found", `no skill candidate named ${slug}`);
  }
}

export interface AcceptSkillCandidateOptions {
  readonly agencHome: string;
  readonly slug: string;
  /** Names that already resolve to a skill; accepting one of them is refused. */
  readonly installedSkillNames: Iterable<string>;
  /** Destination root; defaults to the user skills root `<AGENC_HOME>/skills`. */
  readonly skillsRoot?: string;
  readonly sessionId?: string;
}

/**
 * Promote a draft: move `<candidates>/<slug>` to `<skills root>/<slug>` so the
 * loader picks it up on its next scan, drop the provenance file from the
 * moved directory, and record the acceptance. Refuses when the name already
 * belongs to any installed skill or an occupied directory.
 */
export async function acceptSkillCandidate(
  options: AcceptSkillCandidateOptions,
): Promise<{ readonly path: string }> {
  const source = resolveSkillCandidateDirectory(options.agencHome, options.slug);
  if (!(await pathExists(join(source, SKILL_CANDIDATE_SKILL_FILE)))) {
    throw new SkillCandidateError(
      "not_found",
      `no skill candidate named ${options.slug}`,
    );
  }
  const skillsRoot = options.skillsRoot ?? join(options.agencHome, "skills");
  const target = join(skillsRoot, options.slug);
  if (new Set(options.installedSkillNames).has(options.slug)) {
    throw new SkillCandidateError(
      "name_taken",
      `a skill named ${options.slug} is already installed; rename the candidate or reject it`,
    );
  }
  if (await pathExists(target)) {
    throw new SkillCandidateError(
      "name_taken",
      `${target} already exists; refusing to overwrite it`,
    );
  }
  await mkdir(skillsRoot, { recursive: true });
  try {
    await rename(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await cp(source, target, { recursive: true });
    await rm(source, { recursive: true, force: true });
  }
  await rm(join(target, SKILL_CANDIDATE_RECORD_FILE), { force: true });
  await appendLedger(options.agencHome, {
    slug: options.slug,
    action: "accepted",
    at: new Date().toISOString(),
    ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
  });
  return { path: target };
}

/** Delete a draft and record the rejection. */
export async function rejectSkillCandidate(
  agencHome: string,
  slug: string,
  sessionId?: string,
): Promise<void> {
  const directory = resolveSkillCandidateDirectory(agencHome, slug);
  if (!(await pathExists(directory))) {
    throw new SkillCandidateError("not_found", `no skill candidate named ${slug}`);
  }
  await rm(directory, { recursive: true, force: true });
  await appendLedger(agencHome, {
    slug,
    action: "rejected",
    at: new Date().toISOString(),
    ...(sessionId !== undefined ? { sessionId } : {}),
  });
}
