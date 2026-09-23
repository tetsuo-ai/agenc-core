import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { resolveProjectTrustRootSync } from "../permissions/trust/project-trust.js";

/** Resolve browser profile identity from the workspace files actually in use. */
export function resolveBrowserProjectRootSync(
  cwd: string,
  projectRootMarkers?: readonly string[],
): string {
  const absolute = resolve(cwd);
  let realCwd = absolute;
  try {
    realCwd = realpathSync.native(absolute);
  } catch {
    // If realpath fails, resolve the root from the absolute lexical path.
  }
  return resolveProjectTrustRootSync({ cwd: realCwd, projectRootMarkers });
}

/** Trust walks lexical ancestors, so a different realpath root cannot share either stored profile. */
export function resolveBrowserProfileProjectSync(
  cwd: string,
  projectRootMarkers?: readonly string[],
): { readonly root: string; readonly lexicalRoot: string; readonly trustRootMismatch: boolean } {
  const root = resolveBrowserProjectRootSync(cwd, projectRootMarkers);
  const lexicalTrustRoot = resolveProjectTrustRootSync({ cwd: resolve(cwd), projectRootMarkers });
  return { root, lexicalRoot: lexicalTrustRoot, trustRootMismatch: root !== lexicalTrustRoot };
}
