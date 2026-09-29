import {
  SESSION_ALLOWED_ROOTS_ARG,
  SESSION_ALLOWED_ROOTS_SIG_ARG,
} from "../../agents/_deps/filesystem-args.js";
import { readToolRuntimeContext } from "../runtimes/context.js";
import { safePathAllowingSessionPlanFile } from "./filesystem.js";

/** Catch misplaced Light artifacts even when a broad bypass root was admitted. */
export async function validateFileMutationPath(
  target: string,
  workspaceRoots: readonly string[],
  args: Record<string, unknown>,
  lightMode = false,
): ReturnType<typeof safePathAllowingSessionPlanFile> {
  const light = lightMode ||
    readToolRuntimeContext(args)?.invocation.session.services.runtimeOptions.lightMode === true;
  if (!light) return safePathAllowingSessionPlanFile(target, workspaceRoots, args);

  // Retain signed session/plan authority and the runtime's memory roots. Broad
  // execution permission does not make a sibling directory a task workspace.
  const scopedArgs = Object.create(args) as Record<string, unknown>;
  Object.defineProperties(scopedArgs, {
    [SESSION_ALLOWED_ROOTS_ARG]: { value: undefined },
    [SESSION_ALLOWED_ROOTS_SIG_ARG]: { value: undefined },
  });
  const result = await safePathAllowingSessionPlanFile(target, workspaceRoots, scopedArgs);
  if (result.safe) return result;
  return {
    ...result,
    reason: `${result.reason ?? "Invalid path"}. Light could not write this file. Use a path relative to the workspace (${workspaceRoots.join(", ")}) and retry; no file was written.`,
  };
}
