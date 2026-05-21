// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import { logError } from '../../../utils/log.js'; // upstream-import: keep target is owned by another Z-PURGE item
import { useEffect } from 'react';
import { useNotifications } from '../../context/notifications.js';
import { getIsRemoteMode } from '../../../bootstrap/state';
import { Text } from '../../ink.js';
import type { MCPServerConnection } from '../../../services/mcp/types';
import { hasAgenCAiMcpEverConnected } from '../../../services/mcp/agencai.js';
type Props = {
  mcpClients?: MCPServerConnection[];
};
const EMPTY_MCP_CLIENTS: MCPServerConnection[] = [];
export function useMcpConnectivityStatus(t0) {
  const $ = _c(4);
  const {
    mcpClients: t1
  } = t0;
  const mcpClients = t1 === undefined ? EMPTY_MCP_CLIENTS : t1;
  const {
    addNotification
  } = useNotifications();
  let t2;
  let t3;
  if ($[0] !== addNotification || $[1] !== mcpClients) {
    t2 = () => {
      try {
        if (getIsRemoteMode()) {
          return;
        }
        const failedLocalClients = mcpClients.filter(_temp);
        const failedAgenCAiClients = mcpClients.filter(_temp2);
        const needsAuthLocalServers = mcpClients.filter(_temp3);
        const needsAuthAgenCAiServers = mcpClients.filter(_temp4);
        if (failedLocalClients.length === 0 && failedAgenCAiClients.length === 0 && needsAuthLocalServers.length === 0 && needsAuthAgenCAiServers.length === 0) {
          return;
        }
        if (failedLocalClients.length > 0) {
          addNotification({
            key: "mcp-failed",
            jsx: <><Text color="error">{failedLocalClients.length} MCP{" "}{failedLocalClients.length === 1 ? "server" : "servers"} failed</Text><Text dimColor={true}> · /mcp</Text></>,
            priority: "medium"
          });
        }
        if (failedAgenCAiClients.length > 0) {
          addNotification({
            key: "mcp-agencai-failed",
            jsx: <><Text color="error">{failedAgenCAiClients.length} agenc.tech{" "}{failedAgenCAiClients.length === 1 ? "connector" : "connectors"}{" "}unavailable</Text><Text dimColor={true}> · /mcp</Text></>,
            priority: "medium"
          });
        }
        if (needsAuthLocalServers.length > 0) {
          addNotification({
            key: "mcp-needs-auth",
            jsx: <><Text color="warning">{needsAuthLocalServers.length} MCP{" "}{needsAuthLocalServers.length === 1 ? "server needs" : "servers need"}{" "}auth</Text><Text dimColor={true}> · /mcp</Text></>,
            priority: "medium"
          });
        }
        if (needsAuthAgenCAiServers.length > 0) {
          addNotification({
            key: "mcp-agencai-needs-auth",
            jsx: <><Text color="warning">{needsAuthAgenCAiServers.length} agenc.tech{" "}{needsAuthAgenCAiServers.length === 1 ? "connector needs" : "connectors need"}{" "}auth</Text><Text dimColor={true}> · /mcp</Text></>,
            priority: "medium"
          });
        }
      } catch (error) {
        logError(error);
      }
    };
    t3 = [addNotification, mcpClients];
    $[0] = addNotification;
    $[1] = mcpClients;
    $[2] = t2;
    $[3] = t3;
  } else {
    t2 = $[2];
    t3 = $[3];
  }
  useEffect(t2, t3);
}
function _temp4(client_2) {
  return client_2.type === "needs-auth" && client_2.config.type === "agencai-proxy" && hasAgenCAiMcpEverConnected(client_2.name);
}
function _temp3(client_1) {
  return client_1.type === "needs-auth" && client_1.config.type !== "agencai-proxy";
}
function _temp2(client_0) {
  return client_0.type === "failed" && client_0.config.type === "agencai-proxy" && hasAgenCAiMcpEverConnected(client_0.name);
}
function _temp(client) {
  return client.type === "failed" && client.config.type !== "sse-ide" && client.config.type !== "ws-ide" && client.config.type !== "agencai-proxy";
}
