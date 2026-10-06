/**
 * Project trust over the daemon: `project.trustStatus` and `project.trust`.
 *
 * Core keys trust by project root. A session resolves its cwd to the nearest
 * ancestor holding a configured project-root marker and looks that root up
 * exactly, so trust a client records for the folder the user picked is never
 * read when that folder sits inside a repository. These methods resolve the
 * root the same way a session started in the folder does, which keeps Core
 * the only authority on which project a folder belongs to.
 */

import {
  resolveProjectTrustStatusSync,
  trustProject,
} from "../permissions/trust/project-trust.js";
import { resolveCanonicalSessionCwd } from "../session/session-store.js";
import type {
  ProjectTrustParams,
  ProjectTrustResult,
  ProjectTrustStatusParams,
  ProjectTrustStatusResult,
} from "./protocol/index.js";

export interface AgenCDaemonProjectTrustService {
  status(params: ProjectTrustStatusParams): ProjectTrustStatusResult;
  trust(params: ProjectTrustParams): Promise<ProjectTrustResult>;
}

export interface AgenCProjectTrustServiceOptions {
  /** The daemon home; the sessions it starts read trust from here. */
  readonly agencHome: string;
  /** Operator `project_root_markers`, read on every call so a reload applies. */
  readonly projectRootMarkers: () => readonly string[] | undefined;
}

export class AgenCProjectTrustService implements AgenCDaemonProjectTrustService {
  readonly #options: AgenCProjectTrustServiceOptions;

  constructor(options: AgenCProjectTrustServiceOptions) {
    this.#options = options;
  }

  /** `params.cwd` must already be an absolute, normalized, existing directory. */
  status(params: ProjectTrustStatusParams): ProjectTrustStatusResult {
    const projectRootMarkers = this.#options.projectRootMarkers();
    const { cwd, projectRoot, trusted } = resolveProjectTrustStatusSync({
      agencHome: this.#options.agencHome,
      cwd: sessionWorkspaceRoot(params.cwd),
      ...(projectRootMarkers !== undefined ? { projectRootMarkers } : {}),
    });
    return { cwd, projectRoot, trusted };
  }

  async trust(params: ProjectTrustParams): Promise<ProjectTrustResult> {
    const before = this.status(params);
    const recorded = await trustProject({
      agencHome: this.#options.agencHome,
      projectRoot: before.projectRoot,
    });
    return {
      cwd: before.cwd,
      projectRoot: recorded.projectRoot,
      trusted: true,
      alreadyTrusted: before.trusted,
    };
  }
}

/**
 * The workspace root bootstrap derives for a session created with this cwd:
 * the canonical directory when its identity is stable, else the path as given.
 * The project-root walk starts here, exactly as it does for that session.
 */
function sessionWorkspaceRoot(cwd: string): string {
  const canonical = resolveCanonicalSessionCwd(cwd);
  return canonical.kind === "ok" ? canonical.cwd : cwd;
}
