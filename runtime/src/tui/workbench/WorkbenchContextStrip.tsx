import { homedir } from "node:os";
import { sep as pathSep } from "node:path";

import React from "react";

import { Box, Text } from "../ink.js";
import { useAppStateMaybeOutsideOfProvider } from "../state/AppState.js";
import type { AppState } from "../state/AppStateStore.js";
import {
  getDefaultMainLoopModelSetting,
  parseUserSpecifiedModel,
  renderModelName,
} from "../../utils/model/model.js";
import { getCwdState, getOriginalCwd } from "../../bootstrap/state.js";
import { permissionModeShortTitle } from "../../permissions/mode-display.js";
import type { PermissionMode } from "../../permissions/types.js";

/**
 * Compact, always-visible session-context strip for the workbench status bar.
 *
 * Once a user leaves the welcome screen the summary box (model + workspace)
 * disappears, leaving no persistent indicator of which MODEL is active, the
 * current PERMISSION MODE, or the working directory. This strip restores that
 * always-on context: `model · permission-mode · cwd`.
 *
 * Safety: an elevated/dangerous permission mode (bypassPermissions / unattended
 * / dontAsk / auto) is rendered in the warning color so it stands out — being
 * able to always see when you are in a bypass mode is safety-relevant.
 *
 * Width discipline: the strip never overflows the status-bar row. The caller
 * passes the columns available after the left-hand label so we can budget the
 * remaining space and degrade gracefully — drop cwd first, then the permission
 * detail, always keeping the model. If nothing fits, render nothing.
 *
 * State sources:
 *  - model: app-state main-loop model setting (selectModelSetting), resolved
 *    via parseUserSpecifiedModel + renderModelName. Read directly rather than
 *    via useMainLoopModel, whose extra refresh-signal re-render placeholder is
 *    unnecessary here.
 *  - permission mode: app-state toolPermissionContext.mode.
 *  - cwd: the stable session working directory (getCwdState), NOT getCwd().
 *    getCwd() consults a per-async-context AsyncLocalStorage override used by
 *    concurrent agents; the session status strip must show the session's own
 *    directory, and reading the stable global avoids width-reflow churn when an
 *    override scope enters/exits between renders.
 */

/** Permission modes that grant elevated/auto authority — shown in warning style. */
const DANGEROUS_PERMISSION_MODES: ReadonlySet<PermissionMode> = new Set<PermissionMode>([
  "bypassPermissions",
  "unattended",
  "dontAsk",
  "auto",
]);

export function isDangerousPermissionMode(mode: PermissionMode): boolean {
  return DANGEROUS_PERMISSION_MODES.has(mode);
}

/** Join with the same middle-dot separator the rest of the chrome uses. */
const SEP = " · ";

/**
 * Resolve a compact, display-friendly working directory: home-relativized to
 * `~` and, when still long, reduced to its basename. Never the full long path.
 */
export function compactCwd(cwd: string, home: string = homedir()): string {
  const normalizedHome = home.replace(/[/\\]+$/u, "");
  let display = cwd;
  if (
    normalizedHome.length > 0 &&
    (cwd === normalizedHome || cwd.startsWith(normalizedHome + pathSep))
  ) {
    display = "~" + cwd.slice(normalizedHome.length);
  }
  // Normalize a trailing slash for display.
  display = display.replace(/[/\\]+$/u, "");
  if (display === "") return "/";
  return display;
}

/** Basename of a (possibly already home-relativized) path, for tight widths. */
export function basenameOf(displayPath: string): string {
  const parts = displayPath.split(/[/\\]+/u).filter((part) => part.length > 0);
  const last = parts.at(-1);
  return last ?? displayPath;
}

/** Stable session working directory, ignoring per-async-context overrides. */
function sessionCwd(): string {
  try {
    return getCwdState();
  } catch {
    return getOriginalCwd();
  }
}

type StripParts = {
  readonly model: string;
  readonly modeLabel: string;
  readonly cwd: string;
  readonly cwdBasename: string;
};

/**
 * Compute which parts of the strip fit within `available` columns, degrading
 * in priority order: full → cwd-to-basename → drop cwd → drop mode → model only
 * → hard-truncated model. Returns the chosen segments so the renderer and tests
 * share one source of truth.
 */
export function selectStripSegments(
  parts: StripParts,
  available: number,
): {
  readonly model: string;
  readonly modeLabel: string | null;
  readonly cwd: string | null;
} | null {
  if (available <= 0) return null;

  const width = (
    model: string,
    modeLabel: string | null,
    cwd: string | null,
  ): number => {
    let w = model.length;
    if (modeLabel !== null) w += SEP.length + modeLabel.length;
    if (cwd !== null) w += SEP.length + cwd.length;
    return w;
  };

  // An empty mode label means "nothing worth showing" (the default permission
  // mode carries no signal — rendering the word "default" in the header only
  // raised the question of what it referred to). Normalize it to null so no
  // candidate renders an empty segment between separators.
  const modeLabel = parts.modeLabel.length > 0 ? parts.modeLabel : null;

  // Candidates in descending richness; first that fits wins.
  const candidates: ReadonlyArray<{
    readonly model: string;
    readonly modeLabel: string | null;
    readonly cwd: string | null;
  }> = [
    { model: parts.model, modeLabel, cwd: parts.cwd },
    { model: parts.model, modeLabel, cwd: parts.cwdBasename },
    { model: parts.model, modeLabel, cwd: null },
    { model: parts.model, modeLabel: null, cwd: null },
  ];

  for (const candidate of candidates) {
    if (width(candidate.model, candidate.modeLabel, candidate.cwd) <= available) {
      return candidate;
    }
  }

  // Even the model alone does not fit: hard-truncate the model so we still show
  // *something* (the most important value) rather than overflowing the row.
  if (parts.model.length > 0) {
    const truncated =
      available <= 1
        ? parts.model.slice(0, available)
        : parts.model.slice(0, Math.max(1, available - 1)) + "…";
    return { model: truncated, modeLabel: null, cwd: null };
  }
  return null;
}

function selectMode(state: AppState): PermissionMode {
  return (state.toolPermissionContext?.mode ?? "default") as PermissionMode;
}

/**
 * The active main-loop model setting, mirroring useMainLoopModel's source
 * (mainLoopModelForSession ?? mainLoopModel ?? default), selected directly so
 * this strip subscribes to a plain string without useMainLoopModel's extra
 * refresh-signal re-render placeholder.
 */
function selectModelSetting(state: AppState): string {
  return (
    state.mainLoopModelForSession ??
    state.mainLoopModel ??
    getDefaultMainLoopModelSetting()
  );
}

export function WorkbenchContextStrip({
  /**
   * Columns available for this strip on the status-bar row (the row width minus
   * whatever the left-hand label + activity indicator already consumed). Drives
   * graceful degradation so the strip never overflows the row.
   */
  available,
}: {
  readonly available: number;
}): React.ReactElement | null {
  const modelSetting =
    useAppStateMaybeOutsideOfProvider(selectModelSetting) ??
    getDefaultMainLoopModelSetting();
  const mode = useAppStateMaybeOutsideOfProvider(selectMode) ?? "default";

  const modelLabel = renderModelName(parseUserSpecifiedModel(modelSetting));
  // The default permission mode is noise in the header ("· default ·" answered
  // a question nobody asked); non-default modes ARE signal and stay visible,
  // dangerous ones in the warning color below.
  const modeLabel =
    mode === "default" ? "" : permissionModeShortTitle(mode).toLowerCase();
  const dangerous = isDangerousPermissionMode(mode);
  const cwdDisplay = compactCwd(sessionCwd());

  const segments = selectStripSegments(
    {
      model: modelLabel,
      modeLabel,
      cwd: cwdDisplay,
      cwdBasename: basenameOf(cwdDisplay),
    },
    available,
  );

  if (segments === null) return null;

  // Normal modes render dim; dangerous/elevated modes render in the warning
  // color (and bold) so the safety-relevant state is always visible at a glance.
  const modeColor = dangerous ? "warning" : undefined;

  return (
    <Box flexShrink={0} flexDirection="row">
      <Text dimColor wrap="truncate-end">{SEP}</Text>
      <Text color="text2" wrap="truncate-end">{segments.model}</Text>
      {segments.modeLabel !== null ? (
        <>
          <Text dimColor wrap="truncate-end">{SEP}</Text>
          <Text color={modeColor} dimColor={!dangerous} bold={dangerous} wrap="truncate-end">
            {segments.modeLabel}
          </Text>
        </>
      ) : null}
      {segments.cwd !== null ? (
        <>
          <Text dimColor wrap="truncate-end">{SEP}</Text>
          <Text dimColor wrap="truncate-end">{segments.cwd}</Text>
        </>
      ) : null}
    </Box>
  );
}
