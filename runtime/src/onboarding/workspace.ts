import { access, copyFile, mkdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import {
  WORKSPACE_FILES,
  generateTemplate,
  type WorkspaceFileName,
} from "../gateway/workspace-files.js";

export interface OnboardingWorkspaceWriteResult {
  readonly created: string[];
  readonly overwritten: string[];
  readonly preserved: string[];
  readonly backupPaths: readonly string[];
}

function buildWorkspaceBackupPath(filePath: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${filePath}.bak.${timestamp}`;
}

export async function writeOnboardingWorkspaceFiles(
  workspacePath: string,
  files: Partial<Record<WorkspaceFileName, string>>,
  options: {
    overwrite?: boolean;
    backupExisting?: boolean;
  } = {},
): Promise<OnboardingWorkspaceWriteResult> {
  await mkdir(workspacePath, { recursive: true });

  const created: string[] = [];
  const overwritten: string[] = [];
  const preserved: string[] = [];
  const backupPaths: string[] = [];

  for (const fileName of Object.values(WORKSPACE_FILES)) {
    const filePath = join(workspacePath, fileName);
    const content = files[fileName] ?? generateTemplate(fileName);
    let exists = true;
    try {
      await access(filePath, constants.F_OK);
    } catch {
      exists = false;
    }

    if (!exists) {
      await writeFile(filePath, content, {
        encoding: "utf-8",
        flag: "wx",
      });
      created.push(fileName);
      continue;
    }

    if (!options.overwrite) {
      preserved.push(fileName);
      continue;
    }

    if (options.backupExisting) {
      const backupPath = buildWorkspaceBackupPath(filePath);
      await copyFile(filePath, backupPath);
      backupPaths.push(backupPath);
    }

    await writeFile(filePath, content, {
      encoding: "utf-8",
    });
    overwritten.push(fileName);
  }

  return {
    created,
    overwritten,
    preserved,
    backupPaths,
  };
}
