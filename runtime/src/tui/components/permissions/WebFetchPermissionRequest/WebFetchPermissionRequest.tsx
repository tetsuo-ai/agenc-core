// @ts-nocheck
// Moved-source note: imported by moved purge roots until the owning subsystem is absorbed.
import React, { useCallback, useMemo } from 'react';
import { Box, Text, useTheme } from '../../../ink.js';
import { WebFetchTool } from '../../../../tools/WebFetchTool/WebFetchTool';
import { shouldShowAlwaysAllowOptions } from '../../../../utils/permissions/permissionsLoader'; // upstream-import: keep target is owned by another Z-PURGE item
import { type OptionWithDescription, Select } from '../../CustomSelect/select';
import { type UnaryEvent, usePermissionRequestLogging } from '../hooks';
import { PermissionDialog } from '../PermissionDialog';
import type { PermissionRequestProps } from '../PermissionRequest.js';
import { PermissionRuleExplanation } from '../PermissionRuleExplanation';
import { logUnaryPermissionEvent } from '../utils';

function hostnameFromUrl(url: unknown): string | null {
  if (typeof url !== 'string') {
    return null;
  }
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function inputToPermissionRuleContent(input: {
  [k: string]: unknown;
}): string {
  try {
    const parsedInput = WebFetchTool.inputSchema.safeParse(input);
    if (!parsedInput.success) {
      return `input:${input.toString()}`;
    }
    const hostname = hostnameFromUrl(parsedInput.data.url);
    if (!hostname) {
      return `input:${input.toString()}`;
    }
    return `domain:${hostname}`;
  } catch {
    return `input:${input.toString()}`;
  }
}

export function WebFetchPermissionRequest({
  toolUseConfirm,
  onDone,
  onReject,
  verbose,
  workerBadge,
}: PermissionRequestProps) {
  const [theme] = useTheme();
  const { url } = toolUseConfirm.input as {
    url: string;
  };
  const hostname = hostnameFromUrl(url);
  const unaryEvent = useMemo<UnaryEvent>(() => ({
    completion_type: "tool_use_single",
    language_name: "none"
  }), []);
  usePermissionRequestLogging(toolUseConfirm, unaryEvent);
  const showAlwaysAllowOptions = shouldShowAlwaysAllowOptions();

  const options: OptionWithDescription[] = [{
    label: "Yes",
    value: "yes"
  }];

  if (showAlwaysAllowOptions && hostname) {
    options.push({
      label: <Text>Yes, and don't ask again for <Text bold={true}>{hostname}</Text></Text>,
      value: "yes-dont-ask-again-domain"
    });
  }

  options.push({
    label: <Text>No, and tell AgenC what to do differently <Text bold={true}>(esc)</Text></Text>,
    value: "no"
  });

  const onChange = useCallback((newValue: string) => {
    switch (newValue) {
      case "yes": {
        logUnaryPermissionEvent("tool_use_single", toolUseConfirm, "accept");
        toolUseConfirm.onAllow(toolUseConfirm.input, []);
        onDone();
        break;
      }
      case "yes-dont-ask-again-domain": {
        logUnaryPermissionEvent("tool_use_single", toolUseConfirm, "accept");
        const ruleContent = inputToPermissionRuleContent(toolUseConfirm.input);
        const ruleValue = {
          toolName: toolUseConfirm.tool.name,
          ruleContent
        };
        toolUseConfirm.onAllow(toolUseConfirm.input, [{
          type: "addRules",
          rules: [ruleValue],
          behavior: "allow",
          destination: "localSettings"
        }]);
        onDone();
        break;
      }
      case "no": {
        logUnaryPermissionEvent("tool_use_single", toolUseConfirm, "reject");
        toolUseConfirm.onReject();
        onReject();
        onDone();
      }
    }
  }, [onDone, onReject, toolUseConfirm]);

  const renderedToolUse = WebFetchTool.renderToolUseMessage(toolUseConfirm.input as {
    url: string;
    prompt: string;
  }, {
    theme,
    verbose
  });
  const details = <Box flexDirection="column" paddingX={2} paddingY={1}><Text>{renderedToolUse}</Text><Text dimColor={true}>{toolUseConfirm.description}</Text></Box>;
  const permissionBody = <Box flexDirection="column"><PermissionRuleExplanation permissionResult={toolUseConfirm.permissionResult} toolType="tool" /><Text>Do you want to allow AgenC to fetch this content?</Text><Select options={options} onChange={onChange} onCancel={() => onChange("no")} /></Box>;

  return <PermissionDialog title="Fetch" workerBadge={workerBadge}>{details}{permissionBody}</PermissionDialog>;
}
