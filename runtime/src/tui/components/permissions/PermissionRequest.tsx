import { c as _c } from "react-compiler-runtime";
import { feature } from 'bun:bundle';
import * as React from 'react';
import { EnterPlanModeTool } from '../../../agenc/upstream/tools/EnterPlanModeTool/EnterPlanModeTool.js';
import { ExitPlanModeV2Tool } from '../../../agenc/upstream/tools/ExitPlanModeTool/ExitPlanModeV2Tool.js';
import { useNotifyAfterTimeout } from '../../../agenc/upstream/hooks/useNotifyAfterTimeout.js';
import { useKeybinding } from '../../keybindings/useKeybinding.js';
import type { AnyObject, Tool, ToolUseContext } from '../../../agenc/upstream/Tool.js';
import { AskUserQuestionTool } from '../../../agenc/upstream/tools/AskUserQuestionTool/AskUserQuestionTool.js';
import { BashTool } from '../../../agenc/upstream/tools/BashTool/BashTool.js';
import { FileEditTool } from '../../../agenc/upstream/tools/FileEditTool/FileEditTool.js';
import { FileReadTool } from '../../../agenc/upstream/tools/FileReadTool/FileReadTool.js';
import { FileWriteTool } from '../../../agenc/upstream/tools/FileWriteTool/FileWriteTool.js';
import { GlobTool } from '../../../agenc/upstream/tools/GlobTool/GlobTool.js';
import { GrepTool } from '../../../agenc/upstream/tools/GrepTool/GrepTool.js';
import { NotebookEditTool } from '../../../agenc/upstream/tools/NotebookEditTool/NotebookEditTool.js';
import { PowerShellTool } from '../../../agenc/upstream/tools/PowerShellTool/PowerShellTool.js';
import { SkillTool } from '../../../agenc/upstream/tools/SkillTool/SkillTool.js';
import { WebFetchTool } from '../../../agenc/upstream/tools/WebFetchTool/WebFetchTool.js';
import type { AssistantMessage } from '../../../agenc/upstream/types/message.js';
import type { PermissionDecision } from '../../../agenc/upstream/utils/permissions/PermissionResult.js';
import { AskUserQuestionPermissionRequest } from '../../../agenc/upstream/components/permissions/AskUserQuestionPermissionRequest/AskUserQuestionPermissionRequest.js';
import { BashPermissionRequest } from '../../../agenc/upstream/components/permissions/BashPermissionRequest/BashPermissionRequest.js';
import { EnterPlanModePermissionRequest } from '../../../agenc/upstream/components/permissions/EnterPlanModePermissionRequest/EnterPlanModePermissionRequest.js';
import { ExitPlanModePermissionRequest } from '../../../agenc/upstream/components/permissions/ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.js';
import { FallbackPermissionRequest } from '../../../agenc/upstream/components/permissions/FallbackPermissionRequest.js';
import { FileEditPermissionRequest } from '../../../agenc/upstream/components/permissions/FileEditPermissionRequest/FileEditPermissionRequest.js';
import { FilesystemPermissionRequest } from '../../../agenc/upstream/components/permissions/FilesystemPermissionRequest/FilesystemPermissionRequest.js';
import { FileWritePermissionRequest } from '../../../agenc/upstream/components/permissions/FileWritePermissionRequest/FileWritePermissionRequest.js';
import { NotebookEditPermissionRequest } from '../../../agenc/upstream/components/permissions/NotebookEditPermissionRequest/NotebookEditPermissionRequest.js';
import { PowerShellPermissionRequest } from '../../../agenc/upstream/components/permissions/PowerShellPermissionRequest/PowerShellPermissionRequest.js';
import { SkillPermissionRequest } from '../../../agenc/upstream/components/permissions/SkillPermissionRequest/SkillPermissionRequest.js';
import { WebFetchPermissionRequest } from '../../../agenc/upstream/components/permissions/WebFetchPermissionRequest/WebFetchPermissionRequest.js';

/* eslint-disable @typescript-eslint/no-require-imports */
function unsupportedPermissionFeature<T>(featureName: string): T {
  throw new Error(
    `AgenC build enabled ${featureName}, but that permission UI is not present in this runtime snapshot.`,
  );
}
const ReviewArtifactTool: Tool | null = feature('REVIEW_ARTIFACT')
  ? unsupportedPermissionFeature('REVIEW_ARTIFACT tool')
  : null;
const ReviewArtifactPermissionRequest: React.ComponentType<PermissionRequestProps> | null = feature('REVIEW_ARTIFACT')
  ? unsupportedPermissionFeature('REVIEW_ARTIFACT permission UI')
  : null;
const WorkflowTool: Tool | null = feature('WORKFLOW_SCRIPTS')
  ? unsupportedPermissionFeature('WORKFLOW_SCRIPTS tool')
  : null;
const WorkflowPermissionRequest: React.ComponentType<PermissionRequestProps> | null = feature('WORKFLOW_SCRIPTS')
  ? unsupportedPermissionFeature('WORKFLOW_SCRIPTS permission UI')
  : null;
const MonitorTool = feature('MONITOR_TOOL') ? (require('../../../agenc/upstream/tools/MonitorTool/MonitorTool.js') as typeof import('../../../agenc/upstream/tools/MonitorTool/MonitorTool.js')).MonitorTool : null;
const MonitorPermissionRequest = feature('MONITOR_TOOL') ? (require('../../../agenc/upstream/components/permissions/MonitorPermissionRequest/MonitorPermissionRequest.js') as typeof import('../../../agenc/upstream/components/permissions/MonitorPermissionRequest/MonitorPermissionRequest.js')).MonitorPermissionRequest : null;
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs';
/* eslint-enable @typescript-eslint/no-require-imports */
import type { z } from 'zod/v4';
import type { PermissionUpdate } from '../../../agenc/upstream/utils/permissions/PermissionUpdateSchema.js';
import type { WorkerBadgeProps } from '../../../agenc/upstream/components/permissions/WorkerBadge.js';
function permissionComponentForTool(tool: Tool): React.ComponentType<PermissionRequestProps> {
  switch (tool) {
    case FileEditTool:
      return FileEditPermissionRequest;
    case FileWriteTool:
      return FileWritePermissionRequest;
    case BashTool:
      return BashPermissionRequest;
    case PowerShellTool:
      return PowerShellPermissionRequest;
    case ReviewArtifactTool:
      return ReviewArtifactPermissionRequest ?? FallbackPermissionRequest;
    case WebFetchTool:
      return WebFetchPermissionRequest;
    case NotebookEditTool:
      return NotebookEditPermissionRequest;
    case ExitPlanModeV2Tool:
      return ExitPlanModePermissionRequest;
    case EnterPlanModeTool:
      return EnterPlanModePermissionRequest;
    case SkillTool:
      return SkillPermissionRequest;
    case AskUserQuestionTool:
      return AskUserQuestionPermissionRequest;
    case WorkflowTool:
      return WorkflowPermissionRequest ?? FallbackPermissionRequest;
    case MonitorTool:
      return MonitorPermissionRequest ?? FallbackPermissionRequest;
    case GlobTool:
    case GrepTool:
    case FileReadTool:
      return FilesystemPermissionRequest;
    default:
      return FallbackPermissionRequest;
  }
}
export type PermissionRequestProps<Input extends AnyObject = AnyObject> = {
  toolUseConfirm: ToolUseConfirm<Input>;
  toolUseContext: ToolUseContext;
  onDone(): void;
  onReject(): void;
  verbose: boolean;
  workerBadge: WorkerBadgeProps | undefined;
  /**
   * Register JSX to render in a sticky footer below the scrollable area.
   * Fullscreen mode only (non-fullscreen has no sticky area — terminal
   * scrollback moves everything together). Call with null to clear.
   *
   * Used by ExitPlanModePermissionRequest to keep response options visible
   * while the user scrolls through a long plan. The callback is stable —
   * JSX passed should use refs for callbacks that close over component state
   * to avoid stale closures (React reconciles the JSX, preserving Select's
   * internal focus/input state).
   */
  setStickyFooter?: (jsx: React.ReactNode | null) => void;
};
export type ToolUseConfirm<Input extends AnyObject = AnyObject> = {
  assistantMessage: AssistantMessage;
  tool: Tool<Input>;
  description: string;
  input: z.infer<Input>;
  toolUseContext: ToolUseContext;
  toolUseID: string;
  permissionResult: PermissionDecision;
  permissionPromptStartTimeMs: number;
  /**
   * Called when user interacts with the permission dialog (e.g., arrow keys, tab, typing).
   * This prevents async auto-approval mechanisms (like the bash classifier) from
   * dismissing the dialog while the user is actively engaging with it.
   */
  classifierCheckInProgress?: boolean;
  classifierAutoApproved?: boolean;
  classifierMatchedRule?: string;
  workerBadge?: WorkerBadgeProps;
  onUserInteraction(): void;
  onAbort(): void;
  onDismissCheckmark?(): void;
  onAllow(updatedInput: z.infer<Input>, permissionUpdates: PermissionUpdate[], feedback?: string, contentBlocks?: ContentBlockParam[]): void;
  onReject(feedback?: string, contentBlocks?: ContentBlockParam[]): void;
  recheckPermission(): Promise<void>;
};
function getNotificationMessage(toolUseConfirm: ToolUseConfirm): string {
  const toolName = toolUseConfirm.tool.userFacingName(toolUseConfirm.input as never);
  if (toolUseConfirm.tool === ExitPlanModeV2Tool) {
    return 'AgenC needs your approval for the plan';
  }
  if (toolUseConfirm.tool === EnterPlanModeTool) {
    return 'AgenC wants to enter plan mode';
  }
  if (ReviewArtifactTool !== null && toolUseConfirm.tool === ReviewArtifactTool) {
    return 'AgenC needs your approval for a review artifact';
  }
  if (!toolName || toolName.trim() === '') {
    return 'AgenC needs your attention';
  }
  return `AgenC needs your permission to use ${toolName}`;
}

export const __permissionRequestTest = {
  permissionComponentForTool,
  getNotificationMessage,
  unsupportedFeatureState() {
    return {
      reviewArtifactTool: ReviewArtifactTool,
      reviewArtifactPermissionRequest: ReviewArtifactPermissionRequest,
      workflowTool: WorkflowTool,
      workflowPermissionRequest: WorkflowPermissionRequest,
    };
  },
};

// TODO: Move this to Tool.renderPermissionRequest
export function PermissionRequest(t0) {
  const $ = _c(18);
  const {
    toolUseConfirm,
    toolUseContext,
    onDone,
    onReject,
    verbose,
    workerBadge,
    setStickyFooter
  } = t0;
  let t1;
  if ($[0] !== onDone || $[1] !== onReject || $[2] !== toolUseConfirm) {
    t1 = () => {
      onDone();
      onReject();
      toolUseConfirm.onReject();
    };
    $[0] = onDone;
    $[1] = onReject;
    $[2] = toolUseConfirm;
    $[3] = t1;
  } else {
    t1 = $[3];
  }
  let t2;
  if ($[4] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = {
      context: "Confirmation"
    };
    $[4] = t2;
  } else {
    t2 = $[4];
  }
  useKeybinding("app:interrupt", t1, t2);
  let t3;
  if ($[5] !== toolUseConfirm) {
    t3 = getNotificationMessage(toolUseConfirm);
    $[5] = toolUseConfirm;
    $[6] = t3;
  } else {
    t3 = $[6];
  }
  const notificationMessage = t3;
  useNotifyAfterTimeout(notificationMessage, "permission_prompt");
  let t4;
  if ($[7] !== toolUseConfirm.tool) {
    t4 = permissionComponentForTool(toolUseConfirm.tool);
    $[7] = toolUseConfirm.tool;
    $[8] = t4;
  } else {
    t4 = $[8];
  }
  const PermissionComponent = t4;
  let t5;
  if ($[9] !== PermissionComponent || $[10] !== onDone || $[11] !== onReject || $[12] !== setStickyFooter || $[13] !== toolUseConfirm || $[14] !== toolUseContext || $[15] !== verbose || $[16] !== workerBadge) {
    t5 = <PermissionComponent toolUseContext={toolUseContext} toolUseConfirm={toolUseConfirm} onDone={onDone} onReject={onReject} verbose={verbose} workerBadge={workerBadge} setStickyFooter={setStickyFooter} />;
    $[9] = PermissionComponent;
    $[10] = onDone;
    $[11] = onReject;
    $[12] = setStickyFooter;
    $[13] = toolUseConfirm;
    $[14] = toolUseContext;
    $[15] = verbose;
    $[16] = workerBadge;
    $[17] = t5;
  } else {
    t5 = $[17];
  }
  return t5;
}
