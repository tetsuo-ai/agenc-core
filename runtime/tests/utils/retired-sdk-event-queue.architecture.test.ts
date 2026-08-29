import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

import { describe, expect, test } from "vitest";

const sourceRoot = resolve(import.meta.dirname, "../../src");
const repositoryRoot = resolve(import.meta.dirname, "../../..");

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

describe("retired SDK event queue architecture", () => {
  test("does not restore the orphaned in-process event stream", () => {
    const retiredFiles = [
      resolve(sourceRoot, "utils/sdkEventQueue.ts"),
      resolve(sourceRoot, "utils/task/sdkProgress.ts"),
    ];
    const retiredSymbols =
      /\b(?:enqueueSdkEvent|emitTaskProgress|emitTaskTerminatedSdk|drainSdkEvents|SdkWorkflowProgress)\b/u;
    const violations = sourceFiles(sourceRoot).flatMap((path) =>
      retiredSymbols.test(readFileSync(path, "utf8"))
        ? [relative(sourceRoot, path).replaceAll("\\", "/")]
        : [],
    );

    expect(retiredFiles.map((path) => existsSync(path))).toEqual([
      false,
      false,
    ]);
    expect(violations).toEqual([]);
  });

  test("does not document the queue-only session-state toggle", () => {
    const environmentReference = readFileSync(
      resolve(repositoryRoot, "docs/reference/env.md"),
      "utf8",
    );

    expect(environmentReference).not.toContain(
      "AGENC_EMIT_SESSION_STATE_EVENTS",
    );
  });

  test("keeps the canonical session event log available", () => {
    const eventLog = readFileSync(
      resolve(sourceRoot, "session/event-log.ts"),
      "utf8",
    );

    expect(eventLog).toContain("export class EventLog");
    expect(eventLog).toMatch(/\bsubscribe\(listener: EventListener\)/u);
  });
});
