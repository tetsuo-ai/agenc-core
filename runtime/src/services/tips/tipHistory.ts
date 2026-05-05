/**
 * Source-aligned with `src/services/tips/tipHistory.ts` at donor commit
 * 0ca43335375beec6e58711b797d5b0c4bb5019b8.
 *
 * Shape differences:
 *   - AgenC stores tip history in its config home instead of relying on the
 *     donor global-config module.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { resolveAgenCConfigHomeDir } from "../../utils/envUtils.js";
import type { TipHistoryOptions } from "./types.js";

export type TipHistoryState = {
  readonly numStartups: number;
  readonly tipsHistory: Readonly<Record<string, number>>;
};

const DEFAULT_TIP_HISTORY_STATE: TipHistoryState = Object.freeze({
  numStartups: 1,
  tipsHistory: Object.freeze({}),
});

function finiteSessionCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

export function resolveTipHistoryPath(options: TipHistoryOptions = {}): string {
  if (options.historyFile) return options.historyFile;
  const configHome =
    options.configHomeDir ??
    resolveAgenCConfigHomeDir({
      configDirEnv: process.env.AGENC_CONFIG_DIR,
      agencHomeEnv: process.env.AGENC_HOME,
    });
  return join(configHome, "tips", "history.json");
}

export function readTipHistory(
  options: TipHistoryOptions = {},
): TipHistoryState {
  const path = resolveTipHistoryPath(options);
  if (!existsSync(path)) {
    return {
      ...DEFAULT_TIP_HISTORY_STATE,
      ...(options.sessionCount !== undefined
        ? { numStartups: Math.max(0, Math.floor(options.sessionCount)) }
        : {}),
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      readonly numStartups?: unknown;
      readonly tipsHistory?: unknown;
    };
    const tipsHistory =
      parsed.tipsHistory &&
      typeof parsed.tipsHistory === "object" &&
      !Array.isArray(parsed.tipsHistory)
        ? Object.fromEntries(
            Object.entries(parsed.tipsHistory).flatMap(([tipId, count]) => {
              const sessionCount = finiteSessionCount(count);
              return sessionCount === null ? [] : [[tipId, sessionCount]];
            }),
          )
        : {};
    return {
      numStartups:
        options.sessionCount ??
        finiteSessionCount(parsed.numStartups) ??
        DEFAULT_TIP_HISTORY_STATE.numStartups,
      tipsHistory,
    };
  } catch {
    return {
      ...DEFAULT_TIP_HISTORY_STATE,
      ...(options.sessionCount !== undefined
        ? { numStartups: Math.max(0, Math.floor(options.sessionCount)) }
        : {}),
    };
  }
}

export function writeTipHistory(
  state: TipHistoryState,
  options: TipHistoryOptions = {},
): void {
  const path = resolveTipHistoryPath(options);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmpPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(tmpPath, path);
}

export function recordTipShown(
  tipId: string,
  options: TipHistoryOptions = {},
): void {
  const current = readTipHistory(options);
  const numStartups =
    options.sessionCount ?? Math.max(1, Math.floor(current.numStartups));
  if (current.tipsHistory[tipId] === numStartups) return;
  writeTipHistory(
    {
      ...current,
      numStartups,
      tipsHistory: {
        ...current.tipsHistory,
        [tipId]: numStartups,
      },
    },
    options,
  );
}

export function getSessionsSinceLastShown(
  tipId: string,
  options: TipHistoryOptions = {},
): number {
  const config = readTipHistory(options);
  const lastShown = config.tipsHistory[tipId];
  if (lastShown === undefined) return Number.POSITIVE_INFINITY;
  return Math.max(0, (options.sessionCount ?? config.numStartups) - lastShown);
}
