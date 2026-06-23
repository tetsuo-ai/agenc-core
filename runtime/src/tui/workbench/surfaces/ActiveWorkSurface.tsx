import React, { type RefObject } from "react";

import { Box } from "../../ink.js";
import type { ScrollBoxHandle } from "../../ink/components/ScrollBox.js";
import { useRegisterKeybindingContext } from "../../keybindings/KeybindingContext.js";
import { useKeybindings } from "../../keybindings/useKeybinding.js";
import type { PendingRequest } from "../../permission-requests.js";
import { useWorkbenchDispatch, useWorkbenchState } from "../state.js";
import type { ActiveSurfaceMode, WorkbenchState } from "../types.js";
import { AgentSurface } from "./AgentSurface.js";
import { BufferSurface } from "./BufferSurface.js";
import { DiffSurface } from "./DiffSurface.js";
import { PreviewSurface } from "./PreviewSurface.js";
import { SearchSurface } from "./SearchSurface.js";
import { ShellSurface } from "./ShellSurface.js";
import { TestSurface } from "./TestSurface.js";
import { TranscriptSurface } from "./TranscriptSurface.js";

export type WorkbenchSurfaceRenderProps = {
  readonly focused: boolean;
  readonly transcript: React.ReactNode;
  readonly pendingApproval?: PendingRequest | null;
  readonly scrollRef?: RefObject<ScrollBoxHandle | null>;
  readonly atWelcome?: boolean;
};

export type WorkbenchSurfaceDescriptor = {
  readonly mode: ActiveSurfaceMode;
  readonly title: (state: WorkbenchState) => string;
  readonly keybindings: readonly string[];
  readonly footerHints: string;
  readonly renderBody: (props: WorkbenchSurfaceRenderProps) => React.ReactElement;
  readonly onCommand?: (command: string) => void;
};

export const WORKBENCH_SURFACES: readonly WorkbenchSurfaceDescriptor[] = [
  {
    mode: "transcript",
    title: () => "TRANSCRIPT",
    keybindings: ["q"],
    footerHints: "Surface: ctrl+w h explorer  ctrl+w j composer  ctrl+w d diff",
    renderBody: ({ transcript, scrollRef, atWelcome }) => <TranscriptSurface scrollRef={scrollRef} atWelcome={atWelcome}>{transcript}</TranscriptSurface>,
  },
  {
    mode: "preview",
    title: (state) => state.activeFilePath ?? "PREVIEW",
    keybindings: ["j", "k", "e", "@", "q"],
    footerHints: "Preview: j/k scroll  e edit  @ attach  q close",
    renderBody: ({ focused }) => <PreviewSurface focused={focused} />,
  },
  {
    mode: "buffer",
    title: (state) => state.activeFilePath ?? "BUFFER",
    keybindings: ["shift+tab", "ctrl+x h", "ctrl+x j", "ctrl+x ctrl+e", "ctrl+x q"],
    footerHints: "Buffer: embedded nvim  shift+tab composer  ctrl+x h explorer  ctrl+x ctrl+e external  ctrl+x q close",
    renderBody: ({ focused }) => <BufferSurface focused={focused} />,
  },
  {
    mode: "diff",
    title: () => "DIFF",
    keybindings: ["j", "k", "y", "n", "@", "enter", "q"],
    footerHints: "Diff: j/k file  y/n approve or mark  enter edit  @ attach  q close",
    renderBody: ({ focused, pendingApproval }) => <DiffSurface focused={focused} pendingApproval={pendingApproval} />,
  },
  {
    mode: "shell",
    title: () => "SHELL",
    keybindings: ["g", "enter", "@", "x", "q"],
    footerHints: "Shell: g/enter edit  @ attach error  x stop  q close",
    renderBody: ({ focused }) => <ShellSurface focused={focused} />,
  },
  {
    mode: "test",
    title: () => "TEST",
    keybindings: ["j", "k", "enter", "o", "@", "q"],
    footerHints: "Test: j/k failure  enter edit  o keep focus  @ attach  q close",
    renderBody: ({ focused }) => <TestSurface focused={focused} />,
  },
  {
    mode: "search",
    title: () => "SEARCH",
    keybindings: ["j", "k", "J", "K", "enter", "o", "@", "A", "q"],
    footerHints: "Search: j/k match  J/K file  enter edit  o keep focus  @ attach  A attach all  q close",
    renderBody: ({ focused }) => <SearchSurface focused={focused} />,
  },
  {
    mode: "agent",
    title: () => "AGENT",
    keybindings: ["enter", "x", "q"],
    footerHints: "Agent: enter transcript  x stop where supported  q close",
    renderBody: ({ focused }) => <AgentSurface focused={focused} />,
  },
];

export function descriptorForSurface(mode: ActiveSurfaceMode): WorkbenchSurfaceDescriptor {
  return WORKBENCH_SURFACES.find((surface) => surface.mode === mode) ?? WORKBENCH_SURFACES[0]!;
}

export function footerHintsForSurface(mode: ActiveSurfaceMode): string {
  return descriptorForSurface(mode).footerHints;
}

export function ActiveWorkSurface({
  focused,
  transcript,
  pendingApproval,
  scrollRef,
  atWelcome,
}: {
  readonly focused: boolean;
  readonly transcript: React.ReactNode;
  readonly pendingApproval?: PendingRequest | null;
  readonly scrollRef?: RefObject<ScrollBoxHandle | null>;
  readonly atWelcome?: boolean;
}): React.ReactElement {
  const workbench = useWorkbenchState();
  const dispatch = useWorkbenchDispatch();
  const descriptor = descriptorForSurface(workbench.activeSurfaceMode);
  useRegisterKeybindingContext("Surface", focused);
  useKeybindings(
    {
      "workbench:closeSurface": () => dispatch({ type: "closeSurface" }),
    },
    { context: "Surface", isActive: focused && descriptor.mode !== "buffer" },
  );

  return (
    <Box flexDirection="column" flexGrow={1} height="100%" overflow="hidden" paddingX={1}>
      {descriptor.renderBody({ focused, transcript, pendingApproval, scrollRef, atWelcome })}
    </Box>
  );
}
