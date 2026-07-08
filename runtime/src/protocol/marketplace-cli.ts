/**
 * A2 — MarketplaceKitCliAdapter: read-only `ProtocolTransport` that
 * shells out to the installed `agenc-marketplace` kit binary.
 *
 * Safety design (non-negotiable):
 *   - READ-ONLY. Only `tasks list-claimable` and `explorer task <pda>`
 *     are ever executed. Mutating verbs return `VERB_NOT_ENABLED`.
 *   - No `@solana/web3.js` / Anchor in-process — the kit binary is the
 *     only chain surface, and only its readonly subcommands.
 *   - `execFile` with an args array (never a shell): marketplace task
 *     text can NEVER influence command construction. The only
 *     caller-supplied argv element is a task PDA that must pass a strict
 *     base58 shape check BEFORE any process is spawned; limits are
 *     clamped integers serialized by this adapter.
 *   - Binary resolution: explicit config `cli_path` → `AGENC_MARKETPLACE_CLI`
 *     env → `node_modules/.bin/agenc-marketplace`. NEVER `npx`. Missing
 *     binary is a clean typed `CLI_NOT_FOUND` error.
 *   - Bounded execution: timeout + maxBuffer on every spawn; stdout is
 *     parsed defensively (success flag, plain-object/array shape checks)
 *     and all strings are length-capped and control-char-stripped.
 *
 * @module
 */

import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

import type {
  ClaimableTaskList,
  ClaimableTaskSummary,
  ListClaimableOptions,
  ProtocolResult,
  ProtocolTransport,
  TaskDetail,
  TaskModerationSummary,
} from "./types.js";
import {
  isValidTaskPda,
  protocolError,
  sanitizeUntrustedText,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const DEFAULT_LIST_LIMIT = 10;
const MAX_LIST_LIMIT = 50;

const OWNER_GATED_MESSAGE =
  "This protocol verb mutates on-chain state and is owner-gated: the " +
  "marketplace-cli adapter is read-only (list/detail only) and never signs, " +
  "claims, submits, settles, or stakes. Enabling it requires explicit owner " +
  "approval through a signing flow outside this runtime.";

export interface MarketplaceKitCliAdapterOptions {
  /**
   * Trusted operator-configured binary path (`[protocol].cli_path`).
   * Highest precedence. This comes from local config, never from
   * marketplace data.
   */
  readonly cliPath?: string;
  /** Base dir for the `node_modules/.bin` fallback (default `process.cwd()`). */
  readonly cwd?: string;
  /** Env snapshot consulted for `AGENC_MARKETPLACE_CLI` (default `process.env`). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Per-invocation kill timeout in ms (default 30s). */
  readonly timeoutMs?: number;
  /** Max stdout/stderr bytes before the child is killed (default 1MB). */
  readonly maxOutputBytes?: number;
}

interface CliExecOutcome {
  readonly ok: boolean;
  readonly stdout: string;
  readonly errorCode?: "CLI_NOT_FOUND" | "CLI_TIMEOUT" | "CLI_FAILED" | "CLI_BAD_OUTPUT";
  readonly errorMessage?: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalSanitizedString(
  value: unknown,
  maxLength = 200,
): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const sanitized = sanitizeUntrustedText(value, maxLength);
  return sanitized.length > 0 ? sanitized : undefined;
}

/** Accepts number or numeric-looking string reward/score fields. */
function optionalDisplayNumberish(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return optionalSanitizedString(value, 64);
}

function firstString(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

export class MarketplaceKitCliAdapter implements ProtocolTransport {
  readonly kind = "marketplace-cli";

  private readonly opts: MarketplaceKitCliAdapterOptions;

  constructor(opts: MarketplaceKitCliAdapterOptions = {}) {
    this.opts = opts;
  }

  // ── Binary resolution (trusted local sources only; never npx) ──────

  private resolveCliBinary(): string | undefined {
    const env = this.opts.env ?? process.env;
    const candidates: string[] = [];
    if (
      typeof this.opts.cliPath === "string" &&
      this.opts.cliPath.trim().length > 0
    ) {
      candidates.push(this.opts.cliPath);
    }
    const envPath = env.AGENC_MARKETPLACE_CLI;
    if (typeof envPath === "string" && envPath.trim().length > 0) {
      candidates.push(envPath);
    }
    candidates.push(
      resolve(this.opts.cwd ?? process.cwd(), "node_modules/.bin/agenc-marketplace"),
    );
    for (const candidate of candidates) {
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        // unreadable candidate — try the next resolution source
      }
    }
    return undefined;
  }

  // ── Bounded, shell-free execution ───────────────────────────────────

  private execCli(args: readonly string[]): Promise<CliExecOutcome> {
    const bin = this.resolveCliBinary();
    if (bin === undefined) {
      return Promise.resolve({
        ok: false,
        stdout: "",
        errorCode: "CLI_NOT_FOUND",
        errorMessage:
          "agenc-marketplace binary not found. Set [protocol].cli_path or " +
          "AGENC_MARKETPLACE_CLI, or install the kit so " +
          "node_modules/.bin/agenc-marketplace exists. npx fallback is " +
          "deliberately not supported.",
      });
    }
    return new Promise((resolvePromise) => {
      // execFile: argv array, no shell — untrusted data can never become
      // part of a command line.
      execFile(
        bin,
        [...args],
        {
          timeout: this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          maxBuffer: this.opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
          windowsHide: true,
          env: { ...(this.opts.env ?? process.env) },
          cwd: this.opts.cwd,
        },
        (err, stdout, stderr) => {
          if (err === null) {
            resolvePromise({ ok: true, stdout });
            return;
          }
          const execErr = err as NodeJS.ErrnoException & {
            killed?: boolean;
            signal?: string | null;
          };
          if (execErr.code === "ENOENT") {
            resolvePromise({
              ok: false,
              stdout: "",
              errorCode: "CLI_NOT_FOUND",
              errorMessage: "agenc-marketplace binary could not be executed (ENOENT).",
            });
            return;
          }
          if (execErr.killed === true || execErr.signal != null) {
            resolvePromise({
              ok: false,
              stdout: "",
              errorCode: "CLI_TIMEOUT",
              errorMessage: "agenc-marketplace timed out and was killed.",
            });
            return;
          }
          if (execErr.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
            resolvePromise({
              ok: false,
              stdout: "",
              errorCode: "CLI_BAD_OUTPUT",
              errorMessage: "agenc-marketplace output exceeded the size bound.",
            });
            return;
          }
          const detail = optionalSanitizedString(stderr, 200);
          resolvePromise({
            ok: false,
            stdout: "",
            errorCode: "CLI_FAILED",
            errorMessage:
              detail !== undefined
                ? `agenc-marketplace exited with an error: ${detail}`
                : "agenc-marketplace exited with an error.",
          });
        },
      );
    });
  }

  /**
   * Run + parse a `--json` CLI invocation. Returns the parsed top-level
   * record after the defensive checks every payload must pass: valid
   * JSON, plain object, and no `success: false` flag.
   */
  private async execJson(
    args: readonly string[],
  ): Promise<ProtocolResult<Record<string, unknown>>> {
    const outcome = await this.execCli(args);
    if (!outcome.ok) {
      return protocolError(
        outcome.errorCode ?? "CLI_FAILED",
        outcome.errorMessage ?? "agenc-marketplace invocation failed.",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(outcome.stdout);
    } catch {
      return protocolError(
        "CLI_BAD_OUTPUT",
        "agenc-marketplace produced non-JSON output.",
      );
    }
    if (!isPlainRecord(parsed)) {
      return protocolError(
        "CLI_BAD_OUTPUT",
        "agenc-marketplace JSON output was not an object.",
      );
    }
    if (parsed.success === false) {
      const detail = optionalSanitizedString(parsed.error, 200);
      return protocolError(
        "CLI_FAILED",
        detail !== undefined
          ? `agenc-marketplace reported failure: ${detail}`
          : "agenc-marketplace reported failure.",
      );
    }
    return { ok: true, value: parsed };
  }

  // ── Read-only verbs ────────────────────────────────────────────────

  async listClaimable(
    opts?: ListClaimableOptions,
  ): Promise<ProtocolResult<ClaimableTaskList>> {
    const requested = opts?.limit;
    const limit =
      typeof requested === "number" && Number.isInteger(requested)
        ? Math.min(Math.max(requested, 1), MAX_LIST_LIMIT)
        : DEFAULT_LIST_LIMIT;
    const result = await this.execJson([
      "--network",
      "mainnet",
      "--json",
      "tasks",
      "list-claimable",
      "--limit",
      String(limit),
      "--compact",
    ]);
    if (!result.ok) return result;
    return { ok: true, value: parseClaimableList(result.value) };
  }

  async taskDetail(taskPda: string): Promise<ProtocolResult<TaskDetail>> {
    // Validate BEFORE spawn: shell metacharacters, quotes, whitespace,
    // and flag-like strings all fail the base58 shape check.
    if (!isValidTaskPda(taskPda)) {
      return protocolError(
        "INVALID_ARGUMENT",
        "Invalid task PDA: expected a base58 Solana address (32-44 chars). " +
          "No command was executed.",
      );
    }
    const result = await this.execJson([
      "--network",
      "mainnet",
      "--json",
      "explorer",
      "task",
      taskPda,
    ]);
    if (!result.ok) return result;
    return { ok: true, value: parseTaskDetail(result.value, taskPda) };
  }

  // ── Mutating verbs: typed, owner-gated, never wired ────────────────

  private ownerGated(): Promise<ProtocolResult<never>> {
    return Promise.resolve(
      protocolError("VERB_NOT_ENABLED", OWNER_GATED_MESSAGE),
    );
  }

  claimTask(_taskPda: string): Promise<ProtocolResult<never>> {
    return this.ownerGated();
  }

  delegateStep(_agent: string, _step: string): Promise<ProtocolResult<never>> {
    return this.ownerGated();
  }

  submitProof(_target?: string): Promise<ProtocolResult<never>> {
    return this.ownerGated();
  }

  settleTask(_taskPda?: string): Promise<ProtocolResult<never>> {
    return this.ownerGated();
  }

  adjustStake(_amount?: string): Promise<ProtocolResult<never>> {
    return this.ownerGated();
  }
}

// ─────────────────────────────────────────────────────────────────────
// Defensive payload parsing (all inputs untrusted)
// ─────────────────────────────────────────────────────────────────────

const PDA_KEYS = ["taskPda", "task_pda", "pda", "task", "address"] as const;
const STATUS_KEYS = ["status", "state"] as const;
const REWARD_KEYS = ["reward", "rewardSol", "reward_sol", "rewardLamports"] as const;
const DESCRIPTION_KEYS = ["description", "title", "summary"] as const;

function extractTaskArray(payload: Record<string, unknown>): readonly unknown[] {
  for (const key of ["tasks", "result", "data", "items"]) {
    const value = payload[key];
    if (Array.isArray(value)) return value;
    if (isPlainRecord(value) && Array.isArray(value.tasks)) return value.tasks;
  }
  return [];
}

function parseTaskSummary(entry: unknown): ClaimableTaskSummary | undefined {
  if (!isPlainRecord(entry)) return undefined;
  const pdaRaw = firstString(entry, PDA_KEYS);
  if (pdaRaw === undefined || !isValidTaskPda(pdaRaw)) return undefined;
  const status = optionalSanitizedString(firstString(entry, STATUS_KEYS) ?? undefined, 64);
  const reward = optionalDisplayNumberish(
    REWARD_KEYS.map((k) => entry[k]).find((v) => v !== undefined),
  );
  const description = optionalSanitizedString(
    firstString(entry, DESCRIPTION_KEYS) ?? undefined,
    160,
  );
  return Object.freeze({
    taskPda: pdaRaw,
    ...(status !== undefined ? { status } : {}),
    ...(reward !== undefined ? { reward } : {}),
    ...(description !== undefined ? { description } : {}),
  });
}

function parseClaimableList(payload: Record<string, unknown>): ClaimableTaskList {
  const tasks: ClaimableTaskSummary[] = [];
  for (const entry of extractTaskArray(payload)) {
    const summary = parseTaskSummary(entry);
    if (summary !== undefined) tasks.push(summary);
  }
  return Object.freeze({ tasks: Object.freeze(tasks) });
}

function parseModeration(value: unknown): TaskModerationSummary | undefined {
  if (!isPlainRecord(value)) return undefined;
  const status = optionalSanitizedString(value.status, 64);
  const riskScore =
    typeof value.riskScore === "number" && Number.isFinite(value.riskScore)
      ? value.riskScore
      : undefined;
  const advisoryOnly =
    typeof value.advisoryOnly === "boolean" ? value.advisoryOnly : undefined;
  const hardBoundary =
    typeof value.hardBoundary === "boolean" ? value.hardBoundary : undefined;
  if (
    status === undefined &&
    riskScore === undefined &&
    advisoryOnly === undefined &&
    hardBoundary === undefined
  ) {
    return undefined;
  }
  return Object.freeze({
    ...(status !== undefined ? { status } : {}),
    ...(riskScore !== undefined ? { riskScore } : {}),
    ...(advisoryOnly !== undefined ? { advisoryOnly } : {}),
    ...(hardBoundary !== undefined ? { hardBoundary } : {}),
  });
}

function parseTaskDetail(
  payload: Record<string, unknown>,
  requestedPda: string,
): TaskDetail {
  // The task record may be the payload itself or nested under a
  // well-known key; probe defensively.
  let record: Record<string, unknown> = payload;
  for (const key of ["task", "result", "data"]) {
    const nested = payload[key];
    if (isPlainRecord(nested)) {
      record = nested;
      break;
    }
  }
  const status = optionalSanitizedString(firstString(record, STATUS_KEYS) ?? undefined, 64);
  const reward = optionalDisplayNumberish(
    REWARD_KEYS.map((k) => record[k]).find((v) => v !== undefined),
  );
  const description = optionalSanitizedString(
    firstString(record, DESCRIPTION_KEYS) ?? undefined,
    400,
  );
  const moderation = parseModeration(record.moderation);
  return Object.freeze({
    // Echo the validated request PDA, never a payload-supplied one: the
    // caller's validated input is the trust anchor.
    taskPda: requestedPda,
    ...(status !== undefined ? { status } : {}),
    ...(reward !== undefined ? { reward } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(moderation !== undefined ? { moderation } : {}),
  });
}
