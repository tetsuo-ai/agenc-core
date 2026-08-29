import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import { logError } from '../../../utils/log.js'; // upstream-import: keep target is owned by another Z-PURGE item
import { useEffect } from 'react';
import { useNotifications } from '../../context/notifications.js';
import { getIsRemoteMode } from '../../../bootstrap/state';
import { Text } from '../../ink.js';
import type { MCPServerConnection } from '../../../services/mcp/types';
import type { McpSurfaceServer } from '../../../session/session.js';
type Props = {
  mcpClients?: readonly MCPServerConnection[];
  /** Credential-free daemon status; these entries never contain live SDK clients. */
  mcpServers?: readonly McpSurfaceServer[];
};
const EMPTY_MCP_CLIENTS: readonly MCPServerConnection[] = [];
const EMPTY_MCP_SERVERS: readonly McpSurfaceServer[] = [];
export function useMcpConnectivityStatus(t0: Props) {
  const $ = _c(6);
  const {
    mcpClients: t1,
    mcpServers: t2,
  } = t0;
  const mcpClients = t1 === undefined ? EMPTY_MCP_CLIENTS : t1;
  const mcpServers = t2 === undefined ? EMPTY_MCP_SERVERS : t2;
  const {
    addNotification
  } = useNotifications();
  let t3;
  let t4;
  if ($[0] !== addNotification || $[1] !== mcpClients || $[2] !== mcpServers) {
    t3 = () => {
      try {
        if (getIsRemoteMode()) {
          return;
        }
        const failedLocalClients = mcpClients.filter(_temp);
        const failedAgenCAiClients = mcpClients.filter(_temp2);
        const needsAuthLocalServers = mcpClients.filter(_temp3);
        const needsAuthAgenCAiServers = mcpClients.filter(_temp4);
        const liveServerNames = new Set(mcpClients.map((client) => client.name));
        const failedPassiveServers = mcpServers.filter(
          (server) =>
            !liveServerNames.has(server.name) &&
            server.enabled &&
            server.state === "failed",
        );
        const needsAuthPassiveServers = mcpServers.filter(
          (server) =>
            !liveServerNames.has(server.name) &&
            server.enabled &&
            server.state === "needs-auth",
        );
        const failedLocalCount =
          failedLocalClients.length + failedPassiveServers.length;
        const needsAuthLocalCount =
          needsAuthLocalServers.length + needsAuthPassiveServers.length;
        if (failedLocalCount === 0 && failedAgenCAiClients.length === 0 && needsAuthLocalCount === 0 && needsAuthAgenCAiServers.length === 0) {
          return;
        }
        if (failedLocalCount > 0) {
          addNotification({
            key: "mcp-failed",
            jsx: <><Text color="error">{failedLocalCount} MCP{" "}{failedLocalCount === 1 ? "server" : "servers"} failed</Text><Text dimColor={true}> · /mcp</Text></>,
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
        if (needsAuthLocalCount > 0) {
          addNotification({
            key: "mcp-needs-auth",
            jsx: <><Text color="warning">{needsAuthLocalCount} MCP{" "}{needsAuthLocalCount === 1 ? "server needs" : "servers need"}{" "}auth</Text><Text dimColor={true}> · /mcp</Text></>,
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
    t4 = [addNotification, mcpClients, mcpServers];
    $[0] = addNotification;
    $[1] = mcpClients;
    $[2] = mcpServers;
    $[3] = t3;
    $[4] = t4;
  } else {
    t3 = $[3];
    t4 = $[4];
  }
  useEffect(t3, t4);
}
function _temp4(client_2) {
  return client_2.type === "needs-auth" && client_2.config.type === "agencai-proxy";
}
function _temp3(client_1) {
  return client_1.type === "needs-auth" && client_1.config.type !== "agencai-proxy";
}
function _temp2(client_0) {
  return client_0.type === "failed" && client_0.config.type === "agencai-proxy";
}
function _temp(client) {
  return client.type === "failed" && client.config.type !== "sse-ide" && client.config.type !== "ws-ide" && client.config.type !== "agencai-proxy";
}
