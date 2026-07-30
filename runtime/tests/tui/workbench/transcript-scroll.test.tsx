import { PassThrough } from "node:stream";

import React from "react";
import stripAnsi from "strip-ansi";
import { describe, expect, test } from "vitest";

import { Text } from "../../../src/tui/ink.js";
import type { DOMElement, DOMNode } from "../../../src/tui/ink/dom.js";
import instances from "../../../src/tui/ink/instances.js";
import { createRoot } from "../../../src/tui/ink/root.js";
import type { ScrollBoxHandle } from "../../../src/tui/ink/components/ScrollBox.js";
import {
  AppStateProvider,
  getDefaultAppState,
} from "../../../src/tui/state/AppState.js";
import {
  useModalOrTerminalSize,
  useModalScrollRef,
} from "../../../src/tui/context/modalContext.js";
import { TranscriptSurface } from "../../../src/tui/workbench/surfaces/TranscriptSurface.js";
import { WorkbenchLayout } from "../../../src/tui/workbench/WorkbenchLayout.js";
import {
  clearEditorProposalRecords,
  stageEditorProposalRecord,
} from "../../../src/tui/workbench/editorProposalStore.js";
import { workbenchReducer } from "../../../src/tui/workbench/reducer.js";

type TestStdin = PassThrough & {
  isTTY: boolean;
  ref: () => void;
  setRawMode: (mode: boolean) => void;
  unref: () => void;
};

function createTestStreams(
  columns = 120,
  rows = 30,
): {
  output: () => string;
  stdin: TestStdin;
  stdout: PassThrough;
} {
  let rendered = "";
  const stdout = new PassThrough();
  stdout.on("data", (chunk) => {
    rendered += chunk.toString();
  });
  (stdout as unknown as { columns: number }).columns = columns;
  (stdout as unknown as { rows: number }).rows = rows;
  (stdout as unknown as { isTTY: boolean }).isTTY = true;

  const stdin = new PassThrough() as TestStdin;
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};

  return { output: () => rendered, stdin, stdout };
}

function getRootNode(stdout: PassThrough): DOMElement {
  const instance = instances.get(stdout as unknown as NodeJS.WriteStream);
  if (!instance?.rootNode) throw new Error("Ink root node not found");
  return instance.rootNode;
}

function findScrollBox(node: DOMElement): DOMElement | null {
  if (
    node.nodeName === "ink-box" &&
    node.style.overflowX === "scroll" &&
    node.style.overflowY === "scroll"
  ) {
    return node;
  }

  for (const child of node.childNodes) {
    if (child.nodeName === "#text") continue;
    const found = findScrollBox(child);
    if (found) return found;
  }

  return null;
}

function domText(node: DOMNode): string {
  if (node.nodeName === "#text") return node.nodeValue;
  return node.childNodes.map(domText).join("");
}

function findTextElementContaining(
  node: DOMElement,
  needle: string,
): DOMElement | null {
  if (node.nodeName === "ink-text" && domText(node).includes(needle)) {
    return node;
  }
  for (const child of node.childNodes) {
    if (child.nodeName === "#text") continue;
    const found = findTextElementContaining(child, needle);
    if (found !== null) return found;
  }
  return null;
}

async function sleep(ms = 25): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCondition(
  predicate: () => boolean,
  message: string,
  timeoutMs = 2_000,
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await sleep(10);
  }

  throw new Error(message);
}

function ModalProbe({
  expectedRef,
}: {
  readonly expectedRef: React.RefObject<ScrollBoxHandle | null>;
}): React.ReactElement {
  const size = useModalOrTerminalSize({ rows: -1, columns: -1 });
  const modalRef = useModalScrollRef();

  return (
    <Text>
      modal-size-{size.rows}x{size.columns}-ref-
      {modalRef === expectedRef ? "ok" : "missing"}
    </Text>
  );
}

describe("workbench transcript scroll ownership", () => {
  test("TranscriptSurface owns a sticky ScrollBox when given a scroll ref", async () => {
    const scrollRef = React.createRef<ScrollBoxHandle>();
    const { output, stdin, stdout } = createTestStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });
    let mounted = true;

    try {
      root.render(
        <TranscriptSurface scrollRef={scrollRef}>
          <Text>transcript-scroll-anchor</Text>
        </TranscriptSurface>,
      );

      await waitForCondition(
        () =>
          scrollRef.current !== null &&
          findScrollBox(getRootNode(stdout)) !== null,
        "TranscriptSurface did not attach its ScrollBox",
      );

      const scrollBox = findScrollBox(getRootNode(stdout));
      expect(scrollRef.current).not.toBeNull();
      expect(scrollBox).not.toBeNull();
      expect(scrollBox?.style.flexGrow).toBe(1);
      expect(scrollBox?.style.flexDirection).toBe("column");
      expect(scrollBox?.attributes.stickyScroll).toBe(true);
      // No standalone TRANSCRIPT header: the workbench status bar announces
      // the active surface, so the surface itself stays label-free.
      expect(output()).not.toContain("TRANSCRIPT");
      expect(output()).toContain("transcript-scroll-anchor");

      root.unmount();
      mounted = false;
      await sleep();
      expect(scrollRef.current).toBeNull();
    } finally {
      if (mounted) root.unmount();
      stdin.end();
      stdout.end();
      await sleep();
    }
  });

  test("TranscriptSurface keeps a bounded fallback viewport without a scroll ref", async () => {
    const { output, stdin, stdout } = createTestStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      root.render(
        <TranscriptSurface>
          <Text>transcript-fallback-anchor</Text>
        </TranscriptSurface>,
      );

      await waitForCondition(
        () => output().includes("transcript-fallback-anchor"),
        "TranscriptSurface fallback body did not render",
      );

      expect(findScrollBox(getRootNode(stdout))).toBeNull();
      expect(output()).not.toContain("TRANSCRIPT");
      expect(output()).toContain("transcript-fallback-anchor");
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
      await sleep();
    }
  });

  test("WorkbenchLayout wires its transcript scroll ref into the active surface", async () => {
    const scrollRef = React.createRef<ScrollBoxHandle>();
    const { output, stdin, stdout } = createTestStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });
    let mounted = true;

    try {
      root.render(
        <AppStateProvider
          initialState={{
            ...getDefaultAppState(),
            workbench: {
              ...getDefaultAppState().workbench,
              agentsVisible: false,
              explorerVisible: false,
              activeSurfaceMode: "transcript",
            },
          }}
        >
          <WorkbenchLayout
            transcript={<Text>workbench-scroll-anchor</Text>}
            composer={<Text>composer-anchor</Text>}
            scrollRef={scrollRef}
          />
        </AppStateProvider>,
      );

      await waitForCondition(
        () =>
          scrollRef.current !== null &&
          findScrollBox(getRootNode(stdout)) !== null,
        "WorkbenchLayout did not attach the transcript ScrollBox",
      );

      expect(scrollRef.current).not.toBeNull();
      // The status bar identifies the Workbench; the transcript surface does
      // not repeat a standalone TRANSCRIPT heading.
      expect(output()).not.toContain("TRANSCRIPT");
      expect(output()).toContain("workbench-scroll-anchor");
      expect(output()).toContain("composer-anchor");

      root.unmount();
      mounted = false;
      await sleep();
      expect(scrollRef.current).toBeNull();
    } finally {
      if (mounted) root.unmount();
      stdin.end();
      stdout.end();
      await sleep();
    }
  });

  test.each([148, 120, 80])(
    "Editor transcript panel owns a scrollable focus target at %i columns",
    async (columns) => {
      const panelScrollRef = React.createRef<ScrollBoxHandle>();
      const { output, stdin, stdout } = createTestStreams(columns, 24);
      const root = await createRoot({
        patchConsole: false,
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      });
      const defaults = getDefaultAppState();
      const editor = workbenchReducer(defaults.workbench, {
        type: "switchWorkspaceView",
        view: "editor",
      });
      const withPanel = workbenchReducer(
        workbenchReducer(editor, {
          type: "setRail",
          rail: { kind: "transcript" },
        }),
        { type: "focus", pane: "rail" },
      );

      try {
        root.render(
          <AppStateProvider
            initialState={{ ...defaults, workbench: withPanel }}
          >
            <WorkbenchLayout
              transcript={
                <>
                  {Array.from({ length: 100 }, (_, index) => (
                    <Text key={index}>editor-answer-line-{index}</Text>
                  ))}
                </>
              }
              composer={<Text>editor-composer</Text>}
              panelScrollRef={panelScrollRef}
            />
          </AppStateProvider>,
        );

        await waitForCondition(
          () =>
            panelScrollRef.current !== null &&
            panelScrollRef.current.getScrollHeight() >
              panelScrollRef.current.getViewportHeight(),
          `Editor transcript panel did not become scrollable at ${columns} columns`,
        );

        expect(stripAnsi(output()).replace(/\s+/gu, "")).toContain(
          "AI·PgUp/PgDnscroll",
        );
        panelScrollRef.current?.scrollTo(5);
        expect(panelScrollRef.current?.getScrollTop()).toBe(5);
      } finally {
        root.unmount();
        stdin.end();
        stdout.end();
        await sleep();
      }
    },
  );

  test.each([148, 120, 80])(
    "Editor proposal panel owns the same scroll target at %i columns",
    async (columns) => {
      clearEditorProposalRecords();
      const record = stageEditorProposalRecord({
        version: 1,
        interaction_id: "scroll-proposal",
        path: "src/long.ts",
        buffer_handle: 1,
        base_changedtick: 7,
        base_content_sha256: "a".repeat(64),
        summary: "Review a long generated change",
        edits: [
          {
            id: "long-edit",
            start_line: 1,
            start_column: 0,
            end_line: 1,
            end_column: 1,
            old_text: Array.from({ length: 100 }, (_, index) =>
              index === 0
                ? `${"o".repeat(120)}⊣`
                : index === 99
                  ? "old-final-review-byte"
                  : `old-line-${index}`,
            ).join("\n"),
            new_text: Array.from({ length: 100 }, (_, index) =>
              index === 0
                ? `${"n".repeat(120)}⊢`
                : index === 99
                  ? "new-final-review-byte"
                  : `new-line-${index}`,
            ).join("\n"),
          },
        ],
      });
      const panelScrollRef = React.createRef<ScrollBoxHandle>();
      const { output, stdin, stdout } = createTestStreams(columns, 24);
      const root = await createRoot({
        patchConsole: false,
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      });
      const defaults = getDefaultAppState();
      const editor = workbenchReducer(defaults.workbench, {
        type: "switchWorkspaceView",
        view: "editor",
      });
      const withProposal = workbenchReducer(
        workbenchReducer(editor, {
          type: "setRail",
          rail: { kind: "editor-proposal", proposalId: record.id },
        }),
        { type: "focus", pane: "rail" },
      );

      try {
        root.render(
          <AppStateProvider
            initialState={{ ...defaults, workbench: withProposal }}
          >
            <WorkbenchLayout
              transcript={<Text>unused transcript</Text>}
              composer={<Text>editor-composer</Text>}
              panelScrollRef={panelScrollRef}
            />
          </AppStateProvider>,
        );

        await waitForCondition(
          () =>
            panelScrollRef.current !== null &&
            panelScrollRef.current.getScrollHeight() >
              panelScrollRef.current.getViewportHeight(),
          `Editor proposal panel did not become scrollable at ${columns} columns`,
        );

        const compactOutput = stripAnsi(output()).replace(/\s+/gu, "");
        expect(compactOutput).toContain("EDITORPROPOSAL");
        expect(compactOutput).toContain("PgUp/PgDnscroll");
        const proposalText = domText(getRootNode(stdout));
        expect(proposalText).toContain("⊣");
        expect(proposalText).toContain("⊢");
        expect(proposalText).toContain("old-final-review-byte");
        expect(proposalText).toContain("new-final-review-byte");
        expect(
          findTextElementContaining(getRootNode(stdout), "⊣")?.style.textWrap,
        ).toBe("wrap");
        expect(
          findTextElementContaining(getRootNode(stdout), "⊢")?.style.textWrap,
        ).toBe("wrap");
        panelScrollRef.current.scrollToBottom();
        await waitForCondition(() => {
          const scrollHeight = panelScrollRef.current?.getScrollHeight() ?? 0;
          const viewportHeight =
            panelScrollRef.current?.getViewportHeight() ?? 0;
          return (
            panelScrollRef.current?.getScrollTop() ===
            Math.max(0, scrollHeight - viewportHeight)
          );
        }, `Editor proposal did not scroll to its final review rows at ${columns} columns`);
      } finally {
        root.unmount();
        stdin.end();
        stdout.end();
        clearEditorProposalRecords();
        await sleep();
      }
    },
  );

  test("WorkbenchLayout gives modal content the modal scroll owner and bounded size", async () => {
    const scrollRef = React.createRef<ScrollBoxHandle>();
    const modalScrollRef = React.createRef<ScrollBoxHandle>();
    const { output, stdin, stdout } = createTestStreams(100, 12);
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      root.render(
        <AppStateProvider
          initialState={{
            ...getDefaultAppState(),
            workbench: {
              ...getDefaultAppState().workbench,
              agentsVisible: false,
              explorerVisible: false,
              activeSurfaceMode: "transcript",
            },
          }}
        >
          <WorkbenchLayout
            transcript={<Text>modal-transcript-anchor</Text>}
            composer={<Text>modal-composer-anchor</Text>}
            modal={<ModalProbe expectedRef={modalScrollRef} />}
            modalScrollRef={modalScrollRef}
            scrollRef={scrollRef}
          />
        </AppStateProvider>,
      );

      await waitForCondition(
        () => output().includes("modal-size-6x94-ref-ok"),
        "WorkbenchLayout modal context did not reach modal content",
      );

      expect(output()).toContain("modal-transcript-anchor");
      // On a 12-row viewport the opaque modal owns the bottom slot and may
      // cover the inactive composer; the transcript remains visible above it.
      expect(output()).not.toContain("modal-composer-anchor");
      expect(output()).toContain("modal-size-6x94-ref-ok");
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
      await sleep();
    }
  });
});
