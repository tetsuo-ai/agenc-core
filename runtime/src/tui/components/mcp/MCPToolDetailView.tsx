import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { extractMcpToolDisplayName, getMcpDisplayName } from '../../../services/mcp/mcpStringUtils.js';
import type { Tool } from '../../../tools/Tool.js';
import { selectAgenCTuiGlyphs } from '../../glyphs.js';
import { Box, Text } from '../../ink.js';
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js';
import { Dialog } from '../design-system/Dialog.js';
import type { ServerInfo } from './types.js';

type Props = {
  tool: Tool;
  server: ServerInfo;
  onBack: () => void;
};

type ExitState = {
  pending: boolean;
  keyName: string | null;
};

type ToolDescriptionState =
  | {
      status: 'loading';
      tool: Tool;
      text: '';
    }
  | {
      status: 'loaded' | 'failed';
      tool: Tool;
      text: string;
    };

export function getMCPToolDetailParameterPrefix(env: { readonly AGENC_TUI_GLYPHS?: string } = process.env): string {
  return selectAgenCTuiGlyphs(env).statusDot;
}

export function getMCPToolDetailDescriptionText(
  status: ToolDescriptionState['status'],
  text: string,
  env: { readonly AGENC_TUI_GLYPHS?: string } = process.env,
): string {
  if (status === 'loading') {
    return `Loading description${selectAgenCTuiGlyphs(env).ellipsis}`;
  }
  return text.length > 0 ? text : 'No description available';
}

export function MCPToolDetailView({
  tool,
  server,
  onBack
}: Props): ReactNode {
  const parameterPrefix = getMCPToolDetailParameterPrefix();
  const [toolDescription, setToolDescription] = useState<ToolDescriptionState>({
    status: 'loading',
    tool,
    text: ''
  });

  const toolName = useMemo(() => getMcpDisplayName(tool.name, server.name), [tool.name, server.name]);
  const displayName = useMemo(() => {
    const fullDisplayName = tool.userFacingName ? tool.userFacingName({}) : toolName;
    return extractMcpToolDisplayName(fullDisplayName);
  }, [tool, toolName]);
  const isReadOnly = tool.isReadOnly?.({}) ?? false;
  const isDestructive = tool.isDestructive?.({}) ?? false;
  const isOpenWorld = tool.isOpenWorld?.({}) ?? false;
  const effectiveDescription = toolDescription.tool === tool ? toolDescription : {
    status: 'loading' as const,
    tool,
    text: ''
  };

  useEffect(() => {
    let cancelled = false;
    setToolDescription({
      status: 'loading',
      tool,
      text: ''
    });

    const loadDescription = async () => {
      try {
        const description = await tool.description({}, {
          isNonInteractiveSession: false,
          toolPermissionContext: {
            mode: 'default',
            additionalWorkingDirectories: new Map(),
            alwaysAllowRules: {},
            alwaysDenyRules: {},
            alwaysAskRules: {},
            isBypassPermissionsModeAvailable: false
          },
          tools: []
        });
        if (!cancelled) {
          setToolDescription({
            status: 'loaded',
            tool,
            text: description
          });
        }
      } catch {
        if (!cancelled) {
          setToolDescription({
            status: 'failed',
            tool,
            text: 'Failed to load description'
          });
        }
      }
    };

    void loadDescription();
    return () => {
      cancelled = true;
    };
  }, [tool]);

  const requiredParameters = tool.inputJSONSchema?.required as string[] | undefined;
  const parameterEntries = Object.entries(tool.inputJSONSchema?.properties ?? {});
  const descriptionText = getMCPToolDetailDescriptionText(effectiveDescription.status, effectiveDescription.text);
  const titleContent = <>
    {displayName}
    {isReadOnly && <Text color="success"> [read-only]</Text>}
    {isDestructive && <Text color="error"> [destructive]</Text>}
    {isOpenWorld && <Text dimColor> [open-world]</Text>}
  </>;

  return <Dialog title={titleContent} subtitle={server.name} onCancel={onBack} inputGuide={renderToolDetailInputGuide}>
      <Box flexDirection="column">
        <Box>
          <Text bold>Tool name: </Text>
          <Text dimColor>{toolName}</Text>
        </Box>
        <Box>
          <Text bold>Full name: </Text>
          <Text dimColor>{tool.name}</Text>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Description:</Text>
          <Text wrap="wrap" dimColor={effectiveDescription.status !== 'loaded' || effectiveDescription.text.length === 0}>
            {descriptionText}
          </Text>
        </Box>
        {parameterEntries.length > 0 && <Box flexDirection="column" marginTop={1}>
            <Text bold>Parameters:</Text>
            <Box marginLeft={2} flexDirection="column">
              {parameterEntries.map(([key, value]) => {
          const isRequired = requiredParameters?.includes(key);
          return <Text key={key}>{parameterPrefix} {key}{isRequired && <Text dimColor> (required)</Text>}: <Text dimColor>{typeof value === 'object' && value && 'type' in value ? String(value.type) : 'unknown'}</Text>{typeof value === 'object' && value && 'description' in value && <Text dimColor> - {String(value.description)}</Text>}</Text>;
        })}
            </Box>
          </Box>}
      </Box>
    </Dialog>;
}

function renderToolDetailInputGuide(exitState: ExitState) {
  return exitState.pending ? <Text>Press {exitState.keyName} again to exit</Text> : <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="go back" />;
}
