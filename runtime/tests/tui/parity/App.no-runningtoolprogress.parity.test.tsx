import fs from "node:fs";
import { describe, expect, test } from "vitest";
import { sourcePath } from "../../helpers/source-path.ts";

const APP_SOURCE_PATH = sourcePath("tui/components/App.tsx");

function readSource(): string {
  return fs.readFileSync(APP_SOURCE_PATH, "utf8");
}

describe("R4 RunningToolProgressIndicator removal from App.tsx", () => {
  test("B4.1 the RunningToolProgressIndicator function definition is gone", () => {
    const source = readSource();
    expect(source).not.toMatch(/function\s+RunningToolProgressIndicator\b/);
  });

  test("B4.2 the <RunningToolProgressIndicator ... /> JSX usage is gone", () => {
    const source = readSource();
    expect(source).not.toMatch(/<RunningToolProgressIndicator\b/);
    expect(source).not.toMatch(/progress\s*=\s*\{\s*transcript\.runningToolProgress\s*\}/);
  });

  test("B4.3 App.tsx no longer imports RunningToolProgress from session-transcript", () => {
    const source = readSource();
    expect(source).not.toMatch(/RunningToolProgress(?!Indicator)/);
  });

  test("E4.4 App.tsx no longer reads transcript.runningToolProgress anywhere", () => {
    const source = readSource();
    expect(source).not.toMatch(/transcript\.runningToolProgress/);
  });

  test("E4.1 the new running-tool UI surface is the upstream streamingToolUses prop on <Messages>; verify the wiring still flows from R1 (regression guard for R4 not accidentally removing R1)", () => {
    const source = readSource();
    expect(source).toMatch(/streamingToolUses\s*=\s*\{\s*transcript\.streamingToolUses[^}]*\}/);
    expect(source).toMatch(/<Messages\b/);
  });
});
