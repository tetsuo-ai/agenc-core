import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { getExistingPlanFilePath, type PlanFileContext } from "./plan-files.js";
import { asRecord } from "../utils/record.js";
import { resolveHomeContext } from "../config/home.js";

export interface SessionPlanFileAuthority {
  readonly sessionId: string;
  readonly agencHome: string;
  readonly planFilePath: string;
  readonly agentId?: string;
}

const sessionAuthorities = new WeakMap<object, SessionPlanFileAuthority>();

export function sessionFilesystemContext(
  session: unknown,
): { readonly sessionId: string; readonly agencHome: string } | null {
  const owner = asRecord(session);
  const configStore = asRecord(asRecord(owner?.services)?.configStore);
  const homeContext = asRecord(configStore?.homeContext);
  if (typeof owner?.conversationId !== "string" ||
      !owner.conversationId.trim() || typeof homeContext?.path !== "string" ||
      !homeContext.path.trim()) return null;
  return {
    sessionId: owner.conversationId,
    agencHome: resolveHomeContext({ AGENC_HOME: homeContext.path }).path,
  };
}

export function planFileAuthorityFromContext(
  context: PlanFileContext,
): SessionPlanFileAuthority | null {
  if (!context.sessionId?.trim() || !context.agencHome?.trim()) return null;
  try {
    const planFilePath = getExistingPlanFilePath(context);
    if (planFilePath === null) return null;
    const agencHome = realpathSync(context.agencHome);
    if (agencHome.split(/[\\/]/).some((segment) =>
      [".git", ".agents"].includes(segment.toLowerCase())
    )) return null;
    const plansDirectory = join(agencHome, "plans");
    if (realpathSync(dirname(planFilePath)) !== plansDirectory) return null;
    return Object.freeze({
      sessionId: context.sessionId,
      agencHome,
      planFilePath: join(plansDirectory, basename(planFilePath)),
      ...(context.agentId !== undefined ? { agentId: context.agentId } : {}),
    });
  } catch {
    return null;
  }
}

export function sessionPlanFileAuthority(
  session: unknown,
): SessionPlanFileAuthority | null {
  const owner = asRecord(session);
  const services = asRecord(owner?.services);
  const configStore = asRecord(services?.configStore);
  const homeContext = asRecord(configStore?.homeContext);
  const sessionId = owner?.conversationId;
  const agencHome = homeContext?.path;
  if (owner === null || typeof sessionId !== "string" ||
      typeof agencHome !== "string") return null;
  const existing = sessionAuthorities.get(owner);
  if (existing !== undefined) {
    try {
      return existing.sessionId === sessionId &&
        existing.agencHome === realpathSync(agencHome) ? existing : null;
    } catch {
      return null;
    }
  }
  const authority = planFileAuthorityFromContext({ sessionId, agencHome });
  if (authority !== null) sessionAuthorities.set(owner, authority);
  return authority;
}

export function matchesSessionPlanFile(
  target: string,
  authority: SessionPlanFileAuthority | null | undefined,
  cwd?: string,
): boolean {
  if (
    authority == null || !target || target.length > 4096 ||
    target.includes("\0") || target.split(/[\\/]/).includes("..") ||
    /[*?\[\]{}$%]/.test(target)
  ) return false;
  if (!isAbsolute(target) && cwd === undefined) return false;
  try {
    const absolute = cwd === undefined ? target : resolve(cwd, target);
    if (basename(absolute) !== basename(authority.planFilePath) ||
        realpathSync(dirname(absolute)) !== dirname(authority.planFilePath)) return false;
    try {
      const stat = lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function isSessionPlanMutation(
  tool: unknown,
  input: unknown,
  session: unknown,
): boolean {
  const descriptor = asRecord(tool);
  const metadata = asRecord(descriptor?.metadata);
  const args = asRecord(input);
  if (
    metadata?.source !== "builtin" || metadata.family !== "filesystem" ||
    !["Write", "Edit", "MultiEdit"].includes(String(descriptor?.name)) ||
    typeof args?.file_path !== "string"
  ) return false;
  const owner = asRecord(session);
  const configuration = asRecord(owner?.sessionConfiguration);
  const cwd = typeof args.cwd === "string" ? args.cwd : configuration?.cwd;
  return matchesSessionPlanFile(
    args.file_path,
    sessionPlanFileAuthority(session),
    typeof cwd === "string" ? cwd : undefined,
  );
}
