import React from "react";

import { Box, Text } from "../ink.js";
import type { SpinnerMode } from "../components/spinner/types.js";
import { useAppStateMaybeOutsideOfProvider } from "../state/AppState.js";
import {
  getDefaultMainLoopModelSetting,
  parseUserSpecifiedModel,
  renderModelName,
} from "../../utils/model/model.js";
import { VERSION } from "../../version.js";
import { WorkbenchActivityIndicator } from "./WorkbenchActivityIndicator.js";

export function WorkbenchStatusBar({
  activityMode = null,
  columns,
  contextPctLabel = null,
}: {
  /** Current streaming phase, or null when idle. Drives the working indicator. */
  readonly activityMode?: SpinnerMode | null;
  /**
   * Full status-bar row width (terminal columns). Lets the right-hand context
   * strip budget its remaining space so it degrades gracefully instead of
   * overflowing the row. Omitted in tiny/unknown-width contexts, where the
   * strip is hidden.
   */
  readonly columns?: number;
  /**
   * Real context-window usage label (e.g. "ctx 42%"); null when no assistant
   * usage data exists yet. Rendered ahead of the model/mode/cwd strip, which
   * keeps its own width budget (the label's width is reserved here).
   */
  readonly contextPctLabel?: string | null;
} = {}): React.ReactElement {
  const modelSetting =
    useAppStateMaybeOutsideOfProvider(
      (state) =>
        state.mainLoopModelForSession ??
        state.mainLoopModel ??
        getDefaultMainLoopModelSetting(),
    ) ?? getDefaultMainLoopModelSetting();
  const modelLabel = renderModelName(parseUserSpecifiedModel(modelSetting));
  const contextValue = contextPctLabel?.replace(/^ctx\s+/u, "") ?? null;
  const showContext = contextValue !== null && (columns ?? 120) >= 48;
  const showVersion = (columns ?? 120) >= 64;

  return (
    <Box
      height={2}
      width="100%"
      flexDirection="row"
      flexShrink={0}
      alignItems="center"
      paddingX={2}
      backgroundColor="surfaceBackground"
      borderBottom
      borderBottomColor="lineSoft"
    >
      <Text color="text" bold wrap="truncate-end">agenc</Text>
      <Text color="inactive">  /  </Text>
      <Text color="inactive" wrap="truncate-end">WORKBENCH</Text>
      <WorkbenchActivityIndicator mode={activityMode} />
      <Box flexGrow={1} />
      <Text color="inactive" wrap="truncate-middle">{modelLabel}</Text>
      {showContext ? (
        <>
          <Text color="line">  │  </Text>
          <Text color="inactive">ctx </Text>
          <Text color="text" bold>{contextValue}</Text>
        </>
      ) : null}
      {showVersion ? (
        <>
          <Text color="line">  │  </Text>
          <Text color="text" bold>{VERSION}</Text>
        </>
      ) : null}
    </Box>
  );
}
