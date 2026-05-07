// @ts-nocheck
// Moved-source note: imported by moved purge roots until the owning subsystem is absorbed.
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import { randomUUID } from 'crypto';
import * as React from 'react';
import { BashModeProgress } from '../components/BashModeProgress.js';
import type { SetToolJSXFn } from '../../tools/Tool.js';
import { CanonicalBashTool } from '../../tools/canonicalToolSurface.js';
import { PowerShellTool } from '../../tools/PowerShellTool/PowerShellTool.js';
import type { AttachmentMessage, SystemMessage, UserMessage } from '../../types/message.js';
import type { ShellProgress } from '../../types/tools.js';
import { logEvent } from '../../services/analytics/index.js';
import { errorMessage, ShellError } from '../../utils/errors.js';
import { createSyntheticUserCaveatMessage, createUserInterruptionMessage, createUserMessage, prepareUserContent } from '../../utils/messages.js';
import { resolveDefaultShell } from '../../utils/shell/resolveDefaultShell.js';
import { isPowerShellToolEnabled } from '../../utils/shell/shellToolUtils.js';
import { processToolResultBlock } from '../../utils/toolResultStorage.js';
import { escapeXml } from '../../utils/xml.js';
import type { ProcessUserInputContext } from './processUserInput.js';

function canonicalShellOut(data: unknown): {
  stdout: string;
  stderr: string;
} {
  const record = data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {};
  const metadata = record.metadata &&
    typeof record.metadata === 'object' &&
    !Array.isArray(record.metadata)
    ? record.metadata as Record<string, unknown>
    : {};
  return {
    stdout: typeof metadata.stdout === 'string'
      ? metadata.stdout
      : typeof record.content === 'string'
        ? record.content
        : typeof data === 'string'
          ? data
          : '',
    stderr: typeof metadata.stderr === 'string' ? metadata.stderr : ''
  };
}

export async function processBashCommand(inputString: string, precedingInputBlocks: ContentBlockParam[], attachmentMessages: AttachmentMessage[], context: ProcessUserInputContext, setToolJSX: SetToolJSXFn): Promise<{
  messages: (UserMessage | AttachmentMessage | SystemMessage)[];
  shouldQuery: boolean;
}> {
  // Shell routing (docs/design/ps-shell-selection.md §5.2): consult
  // defaultShell, fall back to bash. isPowerShellToolEnabled() applies the
  // same platform + env-var gate as tools.ts so input-box routing matches
  // tool-list visibility. Computed up front so telemetry records the
  // actual shell, not the raw setting.
  const usePowerShell = isPowerShellToolEnabled() && resolveDefaultShell() === 'powershell';
  logEvent('agenc_input_bash', {
    powershell: usePowerShell
  });
  const userMessage = createUserMessage({
    content: prepareUserContent({
      inputString: `<bash-input>${inputString}</bash-input>`,
      precedingInputBlocks
    })
  });

  // ctrl+b to background indicator
  let jsx: React.ReactNode;

  // Just show initial UI
  setToolJSX({
    jsx: <BashModeProgress input={inputString} progress={null} verbose={context.options.verbose} />,
    shouldHidePromptInput: false
  });
  try {
    const bashModeContext: ProcessUserInputContext = {
      ...context,
      // Follow-up: Clean up this workaround
      setToolJSX: _ => {
        jsx = _?.jsx;
      }
    };

    // Progress UI — shared across both shell backends (both emit ShellProgress)
    const onProgress = (progress: {
      data: ShellProgress;
    }) => {
      setToolJSX({
        jsx: <>
            <BashModeProgress input={inputString!} progress={progress.data} verbose={context.options.verbose} />
            {jsx}
          </>,
        shouldHidePromptInput: false,
        showSpinner: false
      });
    };

    const shellTool = usePowerShell ? PowerShellTool : CanonicalBashTool;
    const response = usePowerShell ? await PowerShellTool.call({
      command: inputString,
      dangerouslyDisableSandbox: true,
      _dangerouslyDisableSandboxApproved: true
    }, bashModeContext, undefined, undefined, onProgress) : await CanonicalBashTool.call({
      command: inputString
    }, bashModeContext, undefined, undefined, onProgress);
    const resultData = response.data;
    if (!resultData) {
      throw new Error('No result received from shell command');
    }
    const shellOut = usePowerShell
      ? {
          stdout: response.data.stdout,
          stderr: response.data.stderr
        }
      : canonicalShellOut(resultData);
    const stderr = shellOut.stderr;
    // Reuse the same formatting pipeline as inline !`cmd` bash (promptShellExecution)
    // and model-initiated Bash. When BashTool.call() persists large output to disk,
    // data.persistedOutputPath is set and the formatter wraps in <persisted-output>.
    // Pass stderr:'' to keep it separate for the <bash-stderr> UI tag.
    const mapped = await processToolResultBlock(shellTool, usePowerShell ? {
      ...response.data,
      stderr: ''
    } : resultData, randomUUID());
    // mapped.content may contain our own <persisted-output> wrapper (trusted
    // XML from buildLargeToolResultMessage). Escaping it would turn structural
    // tags into &lt;persisted-output&gt;, breaking the model's parse and
    // UserBashOutputMessage's extractTag. Escape the raw fallback only.
    const stdout = typeof mapped.content === 'string' ? mapped.content : escapeXml(shellOut.stdout);
    return {
      messages: [createSyntheticUserCaveatMessage(), userMessage, ...attachmentMessages, createUserMessage({
        content: `<bash-stdout>${stdout}</bash-stdout><bash-stderr>${escapeXml(stderr)}</bash-stderr>`
      })],
      shouldQuery: false
    };
  } catch (e) {
    if (e instanceof ShellError) {
      if (e.interrupted) {
        return {
          messages: [createSyntheticUserCaveatMessage(), userMessage, createUserInterruptionMessage({
            toolUse: false
          }), ...attachmentMessages],
          shouldQuery: false
        };
      }
      return {
        messages: [createSyntheticUserCaveatMessage(), userMessage, ...attachmentMessages, createUserMessage({
          content: `<bash-stdout>${escapeXml(e.stdout)}</bash-stdout><bash-stderr>${escapeXml(e.stderr)}</bash-stderr>`
        })],
        shouldQuery: false
      };
    }
    return {
      messages: [createSyntheticUserCaveatMessage(), userMessage, ...attachmentMessages, createUserMessage({
        content: `<bash-stderr>Command failed: ${escapeXml(errorMessage(e))}</bash-stderr>`
      })],
      shouldQuery: false
    };
  } finally {
    setToolJSX(null);
  }
}
