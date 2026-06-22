import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { asRecord } from "../utils/record.js";
import { nonEmptyString } from "../utils/stringUtils.js";

type EnvLike = Pick<NodeJS.ProcessEnv, "AGENC_HOME" | "HOME" | "USERPROFILE">;

export interface PlanFileContext {
  readonly agencHome?: string;
  readonly home?: string;
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly env?: EnvLike;
}

type PlanKey = {
  readonly agencHome: string;
  readonly sessionId: string;
};

const adjectives = [
  "amber",
  "brisk",
  "clear",
  "daring",
  "ember",
  "frost",
  "green",
  "harbor",
  "ivory",
  "juniper",
] as const;

const nouns = [
  "anchor",
  "bridge",
  "cipher",
  "drift",
  "engine",
  "forge",
  "grove",
  "harvest",
  "island",
  "kernel",
] as const;

const planSlugs = new Map<string, string>();

function resolveAgencHome(ctx: PlanFileContext = {}): string {
  if (ctx.agencHome && ctx.agencHome.trim().length > 0) {
    return ctx.agencHome;
  }
  const env = ctx.env ?? process.env;
  if (env.AGENC_HOME && env.AGENC_HOME.trim().length > 0) {
    return env.AGENC_HOME;
  }
  const home = ctx.home ?? env.HOME ?? env.USERPROFILE ?? ".";
  return join(home, ".agenc");
}

export function getPlansDirectory(ctx: PlanFileContext = {}): string {
  const dir = join(resolveAgencHome(ctx), "plans");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // Let the eventual read/write operation surface the filesystem error.
  }
  return dir;
}

function baseKey(ctx: PlanFileContext = {}): PlanKey {
  return {
    agencHome: resolveAgencHome(ctx),
    sessionId: ctx.sessionId?.trim() || "default",
  };
}

function cacheKey(key: PlanKey): string {
  return `${key.agencHome}\0${key.sessionId}`;
}

function slugIndexPath(ctx: PlanFileContext): string {
  return join(getPlansDirectory(ctx), ".slugs.json");
}

function readSlugIndex(ctx: PlanFileContext): Record<string, string> {
  try {
    const raw = readFileSync(slugIndexPath(ctx), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") {
        const slug = sanitizePlanSlug(value);
        if (slug) out[key] = slug;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeSlugIndex(ctx: PlanFileContext, index: Record<string, string>): void {
  try {
    const path = slugIndexPath(ctx);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  } catch {
    // The plan file itself remains authoritative; slug persistence is best-effort.
  }
}

function randomWord<T extends readonly string[]>(words: T): T[number] {
  return words[Math.floor(Math.random() * words.length)]!;
}

function generatePlanSlug(): string {
  const suffix = randomUUID().slice(0, 8);
  return `${randomWord(adjectives)}-${randomWord(nouns)}-${suffix}`;
}

function sanitizePlanSlug(slug: string): string {
  return slug
    .trim()
    .replace(/\.md$/i, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function sanitizeAgentId(agentId: string): string {
  return sanitizePlanSlug(agentId) || "unknown";
}

function pathForSlug(ctx: PlanFileContext, slug: string): string {
  const agentSuffix =
    ctx.agentId && ctx.agentId.trim().length > 0
      ? `-agent-${sanitizeAgentId(ctx.agentId)}`
      : "";
  return join(getPlansDirectory(ctx), `${slug}${agentSuffix}.md`);
}

function getPlanSlug(ctx: PlanFileContext = {}): string {
  const key = baseKey(ctx);
  const keyString = cacheKey(key);
  const cached = planSlugs.get(keyString);
  if (cached) return cached;

  const persisted = readSlugIndex(ctx)[key.sessionId];
  if (persisted) {
    planSlugs.set(keyString, persisted);
    return persisted;
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const slug = generatePlanSlug();
    if (!existsSync(pathForSlug({ ...ctx, agentId: undefined }, slug))) {
      setPlanSlug(ctx, slug);
      return slug;
    }
  }

  const fallback = randomUUID();
  setPlanSlug(ctx, fallback);
  return fallback;
}

export function setPlanSlug(ctx: PlanFileContext, slug: string): string {
  const cleaned = sanitizePlanSlug(slug);
  if (!cleaned) {
    throw new Error("plan slug must not be empty");
  }
  const keyString = cacheKey(baseKey(ctx));
  planSlugs.set(keyString, cleaned);
  const index = readSlugIndex(ctx);
  index[baseKey(ctx).sessionId] = cleaned;
  writeSlugIndex(ctx, index);
  return cleaned;
}

export function clearAllPlanSlugs(): void {
  planSlugs.clear();
}

export function getPlanFilePath(ctx: PlanFileContext = {}): string {
  return pathForSlug(ctx, getPlanSlug(ctx));
}

/**
 * Does `absolutePath` belong to the current session's plan-file family?
 *
 * Mirrors reference `isSessionPlanFile`
 * (`/home/tetsuo/git/AgenC/src/utils/permissions/filesystem.ts:254`):
 *
 *     const expectedPrefix = join(getPlansDirectory(), getPlanSlug())
 *     return path.startsWith(expectedPrefix) && path.endsWith('.md')
 *
 * The prefix match (rather than exact equality) covers both the main
 * plan file `<plansDir>/<slug>.md` and per-agent plans
 * `<plansDir>/<slug>-agent-<agentId>.md`. The `.md` suffix guards
 * against directory-traversal corner cases like `<slug>../../etc/passwd`.
 *
 * The `.slugs.json` index itself is NOT a plan file — its name does not
 * end in `.md` so the suffix check excludes it.
 *
 * Used by the filesystem tools to allowlist plan-file writes regardless
 * of the workspace allowlist, matching AgenC's
 * `checkEditableInternalPath` carve-out (filesystem.ts:1488-1506) which
 * fires before the workspace-write check and bypasses dangerous-path
 * heuristics (the plan dir lives under the AgenC home, which is normally
 * treated as dangerous).
 */
export function isSessionPlanFile(
  absolutePath: string,
  ctx: PlanFileContext = {},
): boolean {
  if (typeof absolutePath !== "string" || absolutePath.length === 0) {
    return false;
  }
  const expectedPrefix = join(getPlansDirectory(ctx), getPlanSlug(ctx));
  return absolutePath.startsWith(expectedPrefix) && absolutePath.endsWith(".md");
}

export function getPlan(ctx: PlanFileContext = {}): string | null {
  const path = getPlanFilePath(ctx);
  try {
    const content = readFileSync(path, "utf8");
    return content.length > 0 ? content : null;
  } catch {
    return null;
  }
}

export async function writePlan(
  ctx: PlanFileContext,
  content: string,
): Promise<string> {
  const filePath = getPlanFilePath(ctx);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
  return filePath;
}

export function writePlanSync(ctx: PlanFileContext, content: string): string {
  const filePath = getPlanFilePath(ctx);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
  return filePath;
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  return nonEmptyString(record[key]) ?? null;
}

function recoverPlanFromRecord(record: Record<string, unknown>): string | null {
  const directType = stringField(record, "type");
  if (directType === "plan_file_reference") {
    return stringField(record, "planContent") ?? stringField(record, "plan_content");
  }

  const attachment = asRecord(record.attachment);
  if (attachment !== null) {
    const attachmentType = stringField(attachment, "type");
    if (attachmentType === "plan_file_reference") {
      return stringField(attachment, "planContent") ??
        stringField(attachment, "plan_content");
    }
  }

  const toolName = stringField(record, "toolName") ??
    stringField(record, "tool") ??
    stringField(record, "name");
  if (toolName === "ExitPlanMode") {
    const input = asRecord(record.input) ??
      asRecord(record.args) ??
      (typeof record.arguments === "string" ? parseJsonObject(record.arguments) : null);
    const plan = input ? stringField(input, "plan") : null;
    if (plan !== null) return plan;
  }

  for (const key of ["payload", "msg", "message", "content"]) {
    const nested = record[key];
    if (typeof nested === "string") {
      const parsed = parseJsonObject(nested);
      if (parsed !== null) {
        const recovered = recoverPlanFromRecord(parsed);
        if (recovered !== null) return recovered;
      }
      continue;
    }
    const nestedRecord = asRecord(nested);
    if (nestedRecord !== null) {
      const recovered = recoverPlanFromRecord(nestedRecord);
      if (recovered !== null) return recovered;
    }
    if (Array.isArray(nested)) {
      const recovered = recoverPlanFromMessages(nested);
      if (recovered !== null) return recovered;
    }
  }

  return null;
}

export function recoverPlanFromMessages(
  messages: readonly unknown[],
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const record = asRecord(messages[index]);
    if (record === null) continue;
    const recovered = recoverPlanFromRecord(record);
    if (recovered !== null) return recovered;
  }
  return null;
}

export function copyPlanForResume(
  source: PlanFileContext,
  target: PlanFileContext,
  opts: { readonly messages?: readonly unknown[] } = {},
): string | null {
  const sourcePath = getPlanFilePath(source);
  const targetPath = getPlanFilePath(target);
  mkdirSync(dirname(targetPath), { recursive: true });
  if (existsSync(sourcePath)) {
    if (sourcePath === targetPath) return targetPath;
    copyFileSync(sourcePath, targetPath);
    return targetPath;
  }
  const recovered = opts.messages
    ? recoverPlanFromMessages(opts.messages)
    : null;
  if (recovered === null) return null;
  writeFileSync(targetPath, recovered, "utf8");
  return targetPath;
}

export function formatPlanText(planContent: string, planPath: string): string {
  return [
    "Current Plan",
    planPath,
    "",
    planContent,
    "",
    'Use "/plan open" to edit this plan in your configured editor.',
  ].join("\n");
}
