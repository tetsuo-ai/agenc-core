import { PassThrough } from "node:stream";

import React from "react";
import { describe, expect, test, vi } from "vitest";

import Text from "../ink/components/Text.js";
import { createRoot } from "../ink/root.js";
import {
  PromptOverlayProvider,
  usePromptOverlay,
  usePromptOverlayDialog,
  useSetPromptOverlay,
  useSetPromptOverlayDialog,
} from "./promptOverlayContext.js";

vi.mock("../../utils/debug.js", () => ({
  logForDebugging: () => {},
}));
vi.mock("../../bootstrap/state.js", () => ({
  flushInteractionTime: () => {},
  markScrollActivity: () => {},
  updateLastInteractionTime: () => {},
}));
vi.mock("../../utils/earlyInput.js", () => ({
  stopCapturingEarlyInput: () => {},
}));
vi.mock("../../utils/envUtils.js", () => ({
  isEnvTruthy: () => false,
}));
vi.mock("../../utils/fullscreen.js", () => ({
  isMouseClicksDisabled: () => true,
}));
vi.mock("../../utils/log.js", () => ({
  logError: () => {},
}));

type Snapshot = {
  overlay: string | null;
  dialog: string | null;
};

function createTestStreams(): {
  stdout: PassThrough;
  stdin: PassThrough & {
    isTTY: boolean;
    setRawMode: (mode: boolean) => void;
    ref: () => void;
    unref: () => void;
  };
} {
  const stdout = new PassThrough();
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode: (mode: boolean) => void;
    ref: () => void;
    unref: () => void;
  };

  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  (stdout as unknown as { columns: number }).columns = 120;

  return { stdout, stdin };
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for prompt overlay context state");
}

function dialogLabel(node: React.ReactNode): string | null {
  if (node === null || node === undefined) return null;
  if (!React.isValidElement(node)) return "node";
  const props = node.props as { children?: React.ReactNode };
  return typeof props.children === "string" ? props.children : "node";
}

function Publisher({ label }: { label: string }): React.ReactNode {
  useSetPromptOverlay({
    suggestions: [
      {
        id: `command-${label}`,
        displayText: `/${label}`,
      },
    ],
    selectedSuggestion: 0,
  });
  useSetPromptOverlayDialog(<Text>{`dialog-${label}`}</Text>);
  return null;
}

function Observer({ snapshots }: { snapshots: Snapshot[] }): React.ReactNode {
  const overlay = usePromptOverlay();
  const dialog = usePromptOverlayDialog();

  React.useEffect(() => {
    snapshots.push({
      overlay: overlay?.suggestions[0]?.displayText ?? null,
      dialog: dialogLabel(dialog),
    });
  }, [dialog, overlay, snapshots]);

  return <Text>observer</Text>;
}

function Harness({
  label,
  snapshots,
}: {
  label: string | null;
  snapshots: Snapshot[];
}): React.ReactNode {
  return (
    <PromptOverlayProvider>
      {label === null ? null : <Publisher label={label} />}
      <Observer snapshots={snapshots} />
    </PromptOverlayProvider>
  );
}

describe("prompt overlay context", () => {
  test("publishes, replaces, and clears overlay data and dialog state", async () => {
    const snapshots: Snapshot[] = [];
    const { stdout, stdin } = createTestStreams();
    const root = await createRoot({
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    });

    try {
      const firstStart = snapshots.length;
      root.render(<Harness label="first" snapshots={snapshots} />);
      await waitForCondition(() =>
        snapshots.slice(firstStart).some(
          (snapshot) =>
            snapshot.overlay === "/first" && snapshot.dialog === "dialog-first",
        ),
      );

      const secondStart = snapshots.length;
      root.render(<Harness label="second" snapshots={snapshots} />);
      await waitForCondition(() =>
        snapshots.slice(secondStart).some(
          (snapshot) =>
            snapshot.overlay === "/second" &&
            snapshot.dialog === "dialog-second",
        ),
      );

      const clearStart = snapshots.length;
      root.render(<Harness label={null} snapshots={snapshots} />);
      await waitForCondition(() =>
        snapshots.slice(clearStart).some(
          (snapshot) => snapshot.overlay === null && snapshot.dialog === null,
        ),
      );
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }

    expect(snapshots).toContainEqual({
      overlay: "/first",
      dialog: "dialog-first",
    });
    expect(snapshots).toContainEqual({
      overlay: "/second",
      dialog: "dialog-second",
    });
    expect(snapshots.at(-1)).toEqual({
      overlay: null,
      dialog: null,
    });
  });
});
