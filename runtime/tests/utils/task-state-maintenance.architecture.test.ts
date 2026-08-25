import { readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

import { describe, expect, test } from "vitest";

const sourceRoot = resolve(import.meta.dirname, "../../src");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = resolve(directory, entry);
    return statSync(path).isDirectory()
      ? sourceFiles(path)
      : /\.(?:ts|tsx)$/u.test(entry)
        ? [path]
        : [];
  });
}

describe("task state maintenance architecture", () => {
  test("does not restore the always-empty task attachment surface", () => {
    const retiredSurface =
      /\b(?:TaskAttachment|generateTaskAttachments|getUnifiedTaskAttachments)\b/u;
    const violations = sourceFiles(sourceRoot).flatMap((path) =>
      retiredSurface.test(readFileSync(path, "utf8"))
        ? [relative(sourceRoot, path).replaceAll("\\", "/")]
        : [],
    );

    expect(violations).toEqual([]);
  });

  test("runs task maintenance separately from model-facing attachments", () => {
    const attachmentSource = readFileSync(
      resolve(sourceRoot, "utils/attachments.ts"),
      "utf8",
    );
    const frameworkSource = readFileSync(
      resolve(sourceRoot, "utils/task/framework.ts"),
      "utf8",
    );

    expect(attachmentSource).toContain(
      "const taskStateMaintenance = isMainThread",
    );
    expect(attachmentSource).toContain(
      "maintainUnifiedTaskState(toolUseContext)",
    );
    expect(attachmentSource).not.toContain("maybe('unified_tasks'");
    expect(attachmentSource).not.toContain("getTaskOutputPath");
    expect(frameworkSource).toContain(
      "export async function collectTaskStateMaintenance",
    );
    expect(frameworkSource).toContain(
      "return { updatedTaskOffsets, evictedTaskIds }",
    );
  });
});
