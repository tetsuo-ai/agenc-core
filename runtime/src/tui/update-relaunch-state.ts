/**
 * Cross-boundary handoff for updating AgenC from inside the TUI.
 *
 * The update menu installs the new version, then records here what to
 * relaunch and asks the app to exit. After `waitUntilExit()` drains Ink and
 * the daemon client is closed, the boot entrypoint consumes the request,
 * moves the daemon and replaces this process with the new version, reopening
 * the same conversation. A module-level slot survives the Ink unmount, like
 * `pending-resume.ts`, and is a build entry for the same reason: the boot
 * entrypoint and the TUI must share one copy.
 *
 * The relaunched process learns why it started from one environment value,
 * read and removed at boot so it never reaches tools or a daemon.
 *
 * @module
 */

export type UpdateInstallType = "install.sh" | "npm" | "Homebrew";

export interface UpdateRelaunchRequest {
  readonly fromVersion: string;
  readonly targetVersion: string;
  /** What to run: the install.sh wrapper, the npm bin or the Homebrew opt bin. */
  readonly command: string;
  readonly installType: UpdateInstallType;
  /** The conversation to reopen. Absent before the first prompt. */
  readonly conversationId?: string;
  readonly cwd: string;
}

export interface UpdateNotice {
  readonly kind: "info" | "error";
  readonly text: string;
}

/**
 * After an update this window could not follow yet: relaunch once the
 * session is idle (`idle`), or once the daemon runs the new version too
 * (`daemon`, when other work held the daemon restart back).
 */
export interface UpdateFollow {
  readonly request: UpdateRelaunchRequest;
  readonly when: "idle" | "daemon";
}

export const AGENC_UPDATE_RELAUNCH_ENV = "AGENC_UPDATE_RELAUNCH";

let pendingRelaunch: UpdateRelaunchRequest | null = null;
let pendingNotice: UpdateNotice | null = null;
let pendingFollow: UpdateFollow | null = null;
let relaunchedVersion: string | null = null;

export function setPendingUpdateRelaunch(request: UpdateRelaunchRequest): void {
  pendingRelaunch = request;
}

export function hasPendingUpdateRelaunch(): boolean {
  return pendingRelaunch !== null;
}

/** Read and clear the relaunch request; null when none was made. */
export function consumePendingUpdateRelaunch(): UpdateRelaunchRequest | null {
  const request = pendingRelaunch;
  pendingRelaunch = null;
  return request;
}

export function setPendingUpdateNotice(notice: UpdateNotice): void {
  pendingNotice = notice;
}

/** The TUI shows this once, when it mounts. */
export function consumePendingUpdateNotice(): UpdateNotice | null {
  const notice = pendingNotice;
  pendingNotice = null;
  return notice;
}

export function setPendingUpdateFollow(follow: UpdateFollow | null): void {
  pendingFollow = follow;
}

export function getPendingUpdateFollow(): UpdateFollow | null {
  return pendingFollow;
}

/** The value the relaunched process receives. */
export function encodeUpdateRelaunchMarker(version: string): string {
  return JSON.stringify({ version });
}

/**
 * Take the marker out of the environment, once, at boot. Returns the version
 * this process was relaunched onto, or null for an ordinary start.
 */
export function takeUpdateRelaunchMarker(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[AGENC_UPDATE_RELAUNCH_ENV];
  if (raw === undefined) return relaunchedVersion;
  delete env[AGENC_UPDATE_RELAUNCH_ENV];
  try {
    const value = JSON.parse(raw) as { version?: unknown };
    if (typeof value.version === "string" && /^[0-9A-Za-z.+-]{1,64}$/.test(value.version)) {
      relaunchedVersion = value.version;
      pendingNotice ??= { kind: "info", text: `Updated to AgenC ${value.version}.` };
    }
  } catch {
    // A malformed marker starts AgenC normally.
  }
  return relaunchedVersion;
}

/** Test-only reset so module slots do not leak across cases. */
export function resetUpdateRelaunchStateForTestingOnly(): void {
  pendingRelaunch = null;
  pendingNotice = null;
  pendingFollow = null;
  relaunchedVersion = null;
}
