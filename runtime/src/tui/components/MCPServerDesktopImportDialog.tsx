import { c as _c } from "react-compiler-runtime";
import { useCallback, useEffect, useState } from 'react';
import { gracefulShutdown } from '../../utils/gracefulShutdown.js';
import { writeToStdout } from 'src/utils/process.js';
import { Box, color, Text, useTheme } from '../ink.js';
import { addMcpConfig, getAllMcpConfigs } from '../../services/mcp/config.js';
import type { ConfigScope, McpServerConfig, ScopedMcpServerConfig } from '../../services/mcp/types.js';
import { logError } from '../../utils/log.js';
import { plural } from '../../utils/stringUtils.js';
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js';
import { SelectMulti } from './CustomSelect/SelectMulti.js';
import { Byline } from './design-system/Byline.js';
import { Dialog } from './design-system/Dialog.js';
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js';
type Props = {
  servers: Record<string, McpServerConfig>;
  scope: ConfigScope;
  onDone(): void;
};

/**
 * Import the selected desktop MCP servers into the given scope, renaming on
 * name collisions, and return how many were written. Rejects if a config-file
 * write fails; the caller (`onSubmit`) catches so it can keep the dialog open
 * rather than completing as if the import succeeded. `addConfig` is injectable
 * for tests.
 */
export async function importSelectedMcpServers(
  selectedServers: readonly string[],
  servers: Record<string, McpServerConfig>,
  existingServers: Record<string, ScopedMcpServerConfig>,
  scope: ConfigScope,
  addConfig: typeof addMcpConfig = addMcpConfig,
): Promise<number> {
  let importedCount = 0;
  for (const serverName of selectedServers) {
    const serverConfig = servers[serverName];
    if (!serverConfig) continue;
    let finalName = serverName;
    if (existingServers[finalName] !== undefined) {
      let counter = 1;
      while (existingServers[`${serverName}_${counter}`] !== undefined) {
        counter++;
      }
      finalName = `${serverName}_${counter}`;
    }
    await addConfig(finalName, serverConfig, scope);
    importedCount++;
  }
  return importedCount;
}

export function MCPServerDesktopImportDialog(t0: Props) {
  const $ = _c(36);
  const {
    servers,
    scope,
    onDone
  } = t0;
  let t1: string[];
  if ($[0] !== servers) {
    t1 = Object.keys(servers);
    $[0] = servers;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  const serverNames = t1;
  let t2: Record<string, ScopedMcpServerConfig>;
  if ($[2] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = {};
    $[2] = t2;
  } else {
    t2 = $[2];
  }
  const [existingServers, setExistingServers] = useState<Record<string, ScopedMcpServerConfig>>(t2);
  let t3: () => void | (() => void);
  let t4: [];
  if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
    t3 = () => {
      let mounted = true;
      getAllMcpConfigs().then((t5) => {
        const {
          servers: servers_0
        } = t5;
        if (!mounted) {
          return;
        }
        return setExistingServers(servers_0);
      }, error => {
        logError(error);
      });
      return () => {
        mounted = false;
      };
    };
    t4 = [];
    $[3] = t3;
    $[4] = t4;
  } else {
    t3 = $[3];
    t4 = $[4];
  }
  useEffect(t3, t4);
  let t5: string[];
  if ($[5] !== existingServers || $[6] !== serverNames) {
    t5 = serverNames.filter((name: string) => existingServers[name] !== undefined);
    $[5] = existingServers;
    $[6] = serverNames;
    $[7] = t5;
  } else {
    t5 = $[7];
  }
  const collisions = t5;
  const [theme] = useTheme();
  let t6;
  if ($[8] !== onDone || $[9] !== scope || $[10] !== theme) {
    t6 = (importedCount_0: number) => {
      if (importedCount_0 > 0) {
        writeToStdout(`\n${color("success", theme)(`Successfully imported ${importedCount_0} MCP ${plural(importedCount_0, "server")} to ${scope} config.`)}\n`);
      } else {
        writeToStdout("\nNo servers were imported.");
      }
      onDone();
      gracefulShutdown();
    };
    $[8] = onDone;
    $[9] = scope;
    $[10] = theme;
    $[11] = t6;
  } else {
    t6 = $[11];
  }
  const done = t6;
  let t7;
  if ($[12] !== done) {
    t7 = () => {
      done(0);
    };
    $[12] = done;
    $[13] = t7;
  } else {
    t7 = $[13];
  }
  done;
  const handleEscCancel = t7;
  const onSubmit = useCallback(async function onSubmit(selectedServers: string[]) {
    try {
      const importedCount = await importSelectedMcpServers(
        selectedServers,
        servers,
        existingServers,
        scope,
      );
      done(importedCount);
    } catch (error) {
      // A config-file write failed (EACCES/EROFS/disk). SelectMulti invokes
      // onSubmit fire-and-forget, so we MUST catch here or the rejection is
      // unhandled. Do NOT complete/shut down as if the import succeeded — log
      // and leave the dialog open so the user can retry or cancel.
      logError(error);
    }
  }, [done, existingServers, scope, servers]);
  const t8 = serverNames.length;
  let t9;
  if ($[14] !== serverNames.length) {
    t9 = plural(serverNames.length, "server");
    $[14] = serverNames.length;
    $[15] = t9;
  } else {
    t9 = $[15];
  }
  const t10 = `Found ${t8} MCP ${t9} in AgenC Desktop.`;
  let t11;
  if ($[16] !== collisions.length) {
    t11 = collisions.length > 0 && <Text color="warning">Note: Some servers already exist with the same name. If selected, they will be imported with a numbered suffix.</Text>;
    $[16] = collisions.length;
    $[17] = t11;
  } else {
    t11 = $[17];
  }
  let t12;
  if ($[18] === Symbol.for("react.memo_cache_sentinel")) {
    t12 = <Text>Please select the servers you want to import:</Text>;
    $[18] = t12;
  } else {
    t12 = $[18];
  }
  let t13;
  let t14;
  if ($[19] !== collisions || $[20] !== serverNames) {
    t13 = serverNames.map((server: string) => ({
      label: `${server}${collisions.includes(server) ? " (already exists)" : ""}`,
      value: server
    }));
    t14 = serverNames.filter((name_0: string) => !collisions.includes(name_0));
    $[19] = collisions;
    $[20] = serverNames;
    $[21] = t13;
    $[22] = t14;
  } else {
    t13 = $[21];
    t14 = $[22];
  }
  let t15;
  if ($[23] !== handleEscCancel || $[24] !== onSubmit || $[25] !== t13 || $[26] !== t14) {
    t15 = <SelectMulti options={t13} defaultValue={t14} onSubmit={onSubmit} onCancel={handleEscCancel} hideIndexes={true} />;
    $[23] = handleEscCancel;
    $[24] = onSubmit;
    $[25] = t13;
    $[26] = t14;
    $[27] = t15;
  } else {
    t15 = $[27];
  }
  let t16;
  if ($[28] !== handleEscCancel || $[29] !== t10 || $[30] !== t11 || $[31] !== t15) {
    t16 = <Dialog title="Import MCP Servers from AgenC Desktop" subtitle={t10} color="success" onCancel={handleEscCancel} hideInputGuide={true}>{t11}{t12}{t15}</Dialog>;
    $[28] = handleEscCancel;
    $[29] = t10;
    $[30] = t11;
    $[31] = t15;
    $[32] = t16;
  } else {
    t16 = $[32];
  }
  let t17;
  if ($[33] === Symbol.for("react.memo_cache_sentinel")) {
    t17 = <Box paddingX={1}><Text dimColor={true} italic={true}><Byline><KeyboardShortcutHint shortcut="Space" action="select" /><KeyboardShortcutHint shortcut="Enter" action="confirm" /><ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="cancel" /></Byline></Text></Box>;
    $[33] = t17;
  } else {
    t17 = $[33];
  }
  let t18;
  if ($[34] !== t16) {
    t18 = <>{t16}{t17}</>;
    $[34] = t16;
    $[35] = t18;
  } else {
    t18 = $[35];
  }
  return t18;
}
