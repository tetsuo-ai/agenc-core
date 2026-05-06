import { c as _c } from "react-compiler-runtime";
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs';
import { useEffect, useRef } from 'react';
import { logError } from '../../agenc/upstream/utils/log.js'; // upstream-import: keep target is owned by another Z-PURGE item
import { z } from 'zod/v4';
import { callIdeRpc } from '../../services/mcp/client';
import type { ConnectedMCPServer, MCPServerConnection } from '../../services/mcp/types';
import type { PermissionMode } from '../../types/permissions';
import { AGENC_IN_CHROME_MCP_SERVER_NAME, isTrackedAgenCInChromeTabId } from '../../agenc/upstream/utils/claudeInChrome/common'; // branding-scan: allow upstream mirror import path pending purge // upstream-import: keep target is owned by another Z-PURGE item
import { lazySchema } from '../../agenc/upstream/utils/lazySchema'; // upstream-import: keep target is owned by another Z-PURGE item
import { enqueuePendingNotification } from '../../agenc/upstream/utils/messageQueueManager'; // upstream-import: keep target is owned by another Z-PURGE item

// Schema for the prompt notification from Chrome extension (JSON-RPC 2.0 format)
const AgenCInChromePromptNotificationSchema = lazySchema(() => z.object({
  method: z.literal('notifications/message'),
  params: z.object({
    prompt: z.string(),
    image: z.object({
      type: z.literal('base64'),
      media_type: z.enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp']),
      data: z.string()
    }).optional(),
    tabId: z.number().optional()
  })
}));

/**
 * A hook that listens for prompt notifications from the AgenC for Chrome extension,
 * enqueues them as user prompts, and syncs permission mode changes to the extension.
 */
export function usePromptsFromAgenCInChrome(mcpClients, toolPermissionMode) {
  const $ = _c(6);
  useRef(undefined);
  let t0;
  if ($[0] !== mcpClients) {
    t0 = [mcpClients];
    $[0] = mcpClients;
    $[1] = t0;
  } else {
    t0 = $[1];
  }
  useEffect(_temp, t0);
  let t1;
  let t2;
  if ($[2] !== mcpClients || $[3] !== toolPermissionMode) {
    t1 = () => {
      const chromeClient = findChromeClient(mcpClients);
      if (!chromeClient) {
        return;
      }
      const chromeMode = toolPermissionMode === "bypassPermissions" ? "skip_all_permission_checks" : "ask";
      callIdeRpc("set_permission_mode", {
        mode: chromeMode
      }, chromeClient);
    };
    t2 = [mcpClients, toolPermissionMode];
    $[2] = mcpClients;
    $[3] = toolPermissionMode;
    $[4] = t1;
    $[5] = t2;
  } else {
    t1 = $[4];
    t2 = $[5];
  }
  useEffect(t1, t2);
}
function _temp() {}
function findChromeClient(clients: MCPServerConnection[]): ConnectedMCPServer | undefined {
  return clients.find((client): client is ConnectedMCPServer => client.type === 'connected' && client.name === AGENC_IN_CHROME_MCP_SERVER_NAME);
}
