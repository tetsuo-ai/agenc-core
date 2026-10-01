/**
 * `agenc trajectories` — curate the redacted trajectory exports written
 * by the opt-in session sink (`session/trajectory-export.ts`, enabled
 * via `AGENC_TRAJECTORY_EXPORT_DIR` / `AGENC_TRAJECTORY_EXPORT_PATH`)
 * into local training data. Pure local file processing; never touches
 * the network.
 *
 * `agenc trajectories export --format sft` emits one chat-schema JSONL
 * row per kept session; `--format dpo` emits preference pairs derived
 * from thread-rollback regenerations (see `buildDpoPairs`).
 *
 * Note: there is no `--require-eval-passed` flag — exported trajectory
 * records carry no evaluation outcome field to filter on.
 */

import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  buildDpoPairs,
  buildSftExample,
  classifyTrajectory,
  isDpoEligible,
  isSftEligible,
  listTrajectoryExportFiles,
  readTrajectoryExports,
  renderTrajectoryJsonl,
} from "../session/trajectory-curate.js";
import {
  AGENC_TRAJECTORY_EXPORT_DIR_ENV,
  AGENC_TRAJECTORY_EXPORT_PATH_ENV,
} from "../session/trajectory-export.js";

import {
  formatAgenCTrajectoriesCliHelpText,
  type TrajectoryExportFormat,
  type AgenCTrajectoriesCliCommand,
} from "./trajectories-cli-args.js";
export {
  formatAgenCTrajectoriesCliHelpText,
  parseAgenCTrajectoriesCliArgs,
  type TrajectoryExportFormat,
  type AgenCTrajectoriesCliCommand,
} from "./trajectories-cli-args.js";

export interface AgenCTrajectoriesCliIo {
  readonly stdout: Pick<NodeJS.WriteStream, "write">;
  readonly stderr: Pick<NodeJS.WriteStream, "write">;
}

export interface AgenCTrajectoriesCliOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly io?: AgenCTrajectoriesCliIo;
}

function resolveExportSourcePath(
  command: { readonly dir?: string },
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (command.dir !== undefined) return command.dir;
  const dirEnv = env[AGENC_TRAJECTORY_EXPORT_DIR_ENV]?.trim();
  if (dirEnv) return dirEnv;
  const pathEnv = env[AGENC_TRAJECTORY_EXPORT_PATH_ENV]?.trim();
  if (pathEnv) return pathEnv;
  return undefined;
}

export async function runAgenCTrajectoriesCli(
  command: AgenCTrajectoriesCliCommand,
  options: AgenCTrajectoriesCliOptions = {},
): Promise<number> {
  const io = options.io ?? { stdout: process.stdout, stderr: process.stderr };
  switch (command.kind) {
    case "help":
      io.stdout.write(`${command.text}\n`);
      return 0;
    case "error":
      io.stderr.write(`agenc: ${command.message}\n`);
      io.stderr.write(`${formatAgenCTrajectoriesCliHelpText()}\n`);
      return 1;
    case "export":
      return runTrajectoriesExport(command, io, options.env ?? process.env);
  }
}

function runTrajectoriesExport(
  command: {
    readonly format: TrajectoryExportFormat;
    readonly dir?: string;
    readonly out?: string;
  },
  io: AgenCTrajectoriesCliIo,
  env: NodeJS.ProcessEnv,
): number {
  const sourcePath = resolveExportSourcePath(command, env);
  if (sourcePath === undefined) {
    io.stderr.write(
      "agenc: no trajectory export source. Pass --dir <path> or set " +
        `${AGENC_TRAJECTORY_EXPORT_DIR_ENV} (the sink's export dir).\n`,
    );
    return 1;
  }
  const resolved = resolve(sourcePath);
  if (!existsSync(resolved)) {
    io.stderr.write(
      `agenc: trajectory export source not found: ${resolved}\n`,
    );
    return 1;
  }

  const fileCount = listTrajectoryExportFiles(resolved).length;
  const parsed = readTrajectoryExports(resolved);

  const rows: unknown[] = [];
  let kept = 0;
  let skippedError = 0;
  let skippedAborted = 0;
  let skippedRejected = 0;
  let skippedIncomplete = 0;
  let skippedNotTrainable = 0;
  let rollbacksSeen = 0;

  for (const [sessionId, items] of parsed.sessions) {
    const classification = classifyTrajectory(items);
    if (!classification.hasTurnComplete) {
      skippedIncomplete += 1;
      continue;
    }
    if (classification.hasErrorEvent) {
      skippedError += 1;
      continue;
    }
    if (classification.hasTurnAborted) {
      skippedAborted += 1;
      continue;
    }
    if (command.format === "sft") {
      if (!isSftEligible(classification)) {
        // Complete/error/abort already handled above, so the remaining
        // SFT exclusions are user rejection markers and rollbacks.
        skippedRejected += 1;
        continue;
      }
      const example = buildSftExample(sessionId, items);
      if (example === null) {
        skippedNotTrainable += 1;
        continue;
      }
      rows.push(example);
      kept += 1;
      continue;
    }
    // dpo
    if (!isDpoEligible(classification)) {
      skippedNotTrainable += 1;
      continue;
    }
    const derivation = buildDpoPairs(sessionId, items);
    rollbacksSeen += derivation.rollbackCount;
    if (derivation.pairs.length === 0) {
      skippedNotTrainable += 1;
      continue;
    }
    rows.push(...derivation.pairs);
    kept += 1;
  }

  const summary =
    `trajectories export: read ${fileCount} file(s), ` +
    `${parsed.sessions.size} session(s), ${parsed.recordCount} record(s) ` +
    `(${parsed.malformedLineCount} malformed, ` +
    `${parsed.unsupportedSchemaCount} unsupported-schema); ` +
    `kept ${kept}, skipped ${skippedIncomplete} incomplete, ` +
    `${skippedError} errored, ${skippedAborted} aborted/interrupted, ` +
    `${skippedRejected} rejected, ${skippedNotTrainable} not-trainable; ` +
    `emitted ${rows.length} ${command.format} row(s)\n`;

  if (rows.length === 0) {
    if (command.format === "dpo") {
      io.stderr.write(
        "agenc: no preference pairs could be derived. Real DPO pairs " +
          "require a session where the user rolled back a turn " +
          "(thread_rolled_back) and re-ran the SAME prompt, so one " +
          "continuation was rejected and another kept from an identical " +
          "prefix. The exported records contain " +
          (rollbacksSeen > 0
            ? `${rollbacksSeen} rollback(s), but none with an identical re-prompt and assistant output on both sides. `
            : "no such rollback regenerations. ") +
          "Nothing was fabricated.\n",
      );
    } else {
      io.stderr.write(
        "agenc: no trajectories survived curation (need at least one " +
          "session that completed a turn with no error, no " +
          "abort/interrupt, and no rejection).\n",
      );
    }
    io.stderr.write(summary);
    return 1;
  }

  const jsonl = renderTrajectoryJsonl(rows);
  if (command.out !== undefined) {
    writeFileSync(resolve(command.out), jsonl, { mode: 0o600 });
  } else {
    io.stdout.write(jsonl);
  }
  io.stderr.write(summary);
  return 0;
}
