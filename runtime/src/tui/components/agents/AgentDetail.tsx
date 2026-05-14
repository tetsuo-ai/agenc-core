import { c as _c } from "react-compiler-runtime";
import figures from 'figures';
import * as React from 'react';
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js';
import { Box, Text } from '../../ink.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { useKeybinding } from '../../keybindings/useKeybinding.js';
import type { Tools } from '../../../tools/Tool';
import { getAgentColor } from 'src/tools/AgentTool/agentColorManager.js';
import { getMemoryScopeDisplay } from '../../../tools/AgentTool/agentMemory';
import { resolveAgentTools } from '../../../tools/AgentTool/agentToolUtils';
import { type AgentDefinition, isBuiltInAgent } from 'src/tools/AgentTool/loadAgentsDir.js';
import { getAgentModelDisplay } from '../../../utils/model/agent.js'; // upstream-import: keep target is owned by another Z-PURGE item
import { Markdown } from '../markdown/Markdown.js';
import { getActualRelativeAgentFilePath } from './agentFileUtils';
import {
  getAgentDetailIndentedValueColumns,
  getAgentDetailValueColumns,
} from './AgentDetail.layout.js';
type Props = {
  agent: AgentDefinition;
  tools: Tools;
  allAgents?: AgentDefinition[];
  onBack: () => void;
};
export function AgentDetail(t0) {
  const $ = _c(56);
  const {
    agent,
    tools,
    onBack
  } = t0;
  const resolvedTools = resolveAgentTools(agent, tools, false);
  let t1;
  if ($[0] !== agent) {
    t1 = getActualRelativeAgentFilePath(agent);
    $[0] = agent;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  const filePath = t1;
  let t2;
  if ($[2] !== agent.agentType) {
    t2 = getAgentColor(agent.agentType);
    $[2] = agent.agentType;
    $[3] = t2;
  } else {
    t2 = $[3];
  }
  const backgroundColor = t2;
  let t3;
  if ($[4] === Symbol.for("react.memo_cache_sentinel")) {
    t3 = {
      context: "Confirmation"
    };
    $[4] = t3;
  } else {
    t3 = $[4];
  }
  useKeybinding("confirm:no", onBack, t3);
  let t4;
  if ($[5] !== onBack) {
    t4 = e => {
      if (e.key === "return") {
        e.preventDefault();
        onBack();
      }
    };
    $[5] = onBack;
    $[6] = t4;
  } else {
    t4 = $[6];
  }
  const handleKeyDown = t4;
  const {
    columns
  } = useTerminalSize();
  const detailWidth = getAgentDetailValueColumns(columns);
  const indentedDetailWidth = getAgentDetailIndentedValueColumns(columns, 2);
  const systemPromptWidth = getAgentDetailIndentedValueColumns(columns, 4);
  const renderToolsList = function renderToolsList() {
    if (resolvedTools.hasWildcard) {
      return <Box width={detailWidth}><Text wrap="wrap">All tools</Text></Box>;
    }
    if (!agent.tools || agent.tools.length === 0) {
      return <Box width={detailWidth}><Text wrap="wrap">None</Text></Box>;
    }
    return <Box flexDirection="column" width={detailWidth}>{resolvedTools.validTools.length > 0 && <Text wrap="wrap">{resolvedTools.validTools.join(", ")}</Text>}{resolvedTools.invalidTools.length > 0 && <Text color="warning" wrap="wrap">{figures.warning} Unrecognized:{" "}{resolvedTools.invalidTools.join(", ")}</Text>}</Box>;
  };
  const T0 = Box;
  const t5 = "column";
  const t6 = 1;
  const t7 = 0;
  const t8 = true;
  let t9;
  if ($[7] !== detailWidth || $[8] !== filePath) {
    t9 = <Box width={detailWidth}><Text dimColor={true} wrap="wrap">{filePath}</Text></Box>;
    $[7] = detailWidth;
    $[8] = filePath;
    $[9] = t9;
  } else {
    t9 = $[9];
  }
  let t10;
  if ($[10] === Symbol.for("react.memo_cache_sentinel")) {
    t10 = <Text><Text bold={true}>Description</Text> (tells AgenC when to use this agent):</Text>;
    $[10] = t10;
  } else {
    t10 = $[10];
  }
  let t11;
  if ($[11] !== agent.whenToUse || $[12] !== indentedDetailWidth) {
    t11 = <Box flexDirection="column">{t10}<Box marginLeft={2} width={indentedDetailWidth}><Text wrap="wrap">{agent.whenToUse}</Text></Box></Box>;
    $[11] = agent.whenToUse;
    $[12] = indentedDetailWidth;
    $[13] = t11;
  } else {
    t11 = $[13];
  }
  const T1 = Box;
  let t12;
  if ($[14] === Symbol.for("react.memo_cache_sentinel")) {
    t12 = <Text><Text bold={true}>Tools</Text>:{" "}</Text>;
    $[14] = t12;
  } else {
    t12 = $[14];
  }
  const t13 = renderToolsList();
  let t14;
  if ($[15] !== T1 || $[16] !== t12 || $[17] !== t13) {
    t14 = <T1 flexDirection="column">{t12}{t13}</T1>;
    $[15] = T1;
    $[16] = t12;
    $[17] = t13;
    $[18] = t14;
  } else {
    t14 = $[18];
  }
  let t15;
  if ($[19] === Symbol.for("react.memo_cache_sentinel")) {
    t15 = <Text bold={true}>Model</Text>;
    $[19] = t15;
  } else {
    t15 = $[19];
  }
  let t16;
  if ($[20] !== agent.model) {
    t16 = getAgentModelDisplay(agent.model);
    $[20] = agent.model;
    $[21] = t16;
  } else {
    t16 = $[21];
  }
  let t17;
  if ($[22] !== detailWidth || $[23] !== t16) {
    t17 = <Box width={detailWidth}><Text wrap="wrap">{t15}: {t16}</Text></Box>;
    $[22] = detailWidth;
    $[23] = t16;
    $[24] = t17;
  } else {
    t17 = $[24];
  }
  let t18;
  if ($[25] !== agent.permissionMode || $[26] !== detailWidth) {
    t18 = agent.permissionMode && <Box width={detailWidth}><Text wrap="wrap"><Text bold={true}>Permission mode</Text>: {agent.permissionMode}</Text></Box>;
    $[25] = agent.permissionMode;
    $[26] = detailWidth;
    $[27] = t18;
  } else {
    t18 = $[27];
  }
  let t19;
  if ($[28] !== agent.memory || $[29] !== detailWidth) {
    t19 = agent.memory && <Box width={detailWidth}><Text wrap="wrap"><Text bold={true}>Memory</Text>: {getMemoryScopeDisplay(agent.memory)}</Text></Box>;
    $[28] = agent.memory;
    $[29] = detailWidth;
    $[30] = t19;
  } else {
    t19 = $[30];
  }
  let t20;
  if ($[31] !== agent.hooks || $[32] !== detailWidth) {
    t20 = agent.hooks && Object.keys(agent.hooks).length > 0 && <Box flexDirection="column"><Text bold={true}>Hooks</Text><Box width={detailWidth}><Text wrap="wrap">{Object.keys(agent.hooks).join(", ")}</Text></Box></Box>;
    $[31] = agent.hooks;
    $[32] = detailWidth;
    $[33] = t20;
  } else {
    t20 = $[33];
  }
  let t21;
  if ($[34] !== agent.skills || $[35] !== detailWidth) {
    t21 = agent.skills && agent.skills.length > 0 && <Box flexDirection="column"><Text bold={true}>Skills</Text><Box width={detailWidth}><Text wrap="wrap">{agent.skills.length > 10 ? `${agent.skills.length} skills` : agent.skills.join(", ")}</Text></Box></Box>;
    $[34] = agent.skills;
    $[35] = detailWidth;
    $[36] = t21;
  } else {
    t21 = $[36];
  }
  let t22;
  if ($[37] !== agent.agentType || $[38] !== backgroundColor) {
    t22 = backgroundColor && <Box><Text><Text bold={true}>Color</Text>:{" "}<Text backgroundColor={backgroundColor} color="inverseText">{" "}{agent.agentType}{" "}</Text></Text></Box>;
    $[37] = agent.agentType;
    $[38] = backgroundColor;
    $[39] = t22;
  } else {
    t22 = $[39];
  }
  let t23;
  if ($[40] !== agent || $[41] !== systemPromptWidth) {
    t23 = !isBuiltInAgent(agent) && <><Box><Text><Text bold={true}>System prompt</Text>:</Text></Box><Box marginLeft={2} marginRight={2} width={systemPromptWidth}><Markdown>{agent.getSystemPrompt()}</Markdown></Box></>;
    $[40] = agent;
    $[41] = systemPromptWidth;
    $[42] = t23;
  } else {
    t23 = $[42];
  }
  let t24;
  if ($[43] !== T0 || $[44] !== handleKeyDown || $[45] !== t11 || $[46] !== t14 || $[47] !== t17 || $[48] !== t18 || $[49] !== t19 || $[50] !== t20 || $[51] !== t21 || $[52] !== t22 || $[53] !== t23 || $[54] !== t9) {
    t24 = <T0 flexDirection={t5} gap={t6} tabIndex={t7} autoFocus={t8} onKeyDown={handleKeyDown}>{t9}{t11}{t14}{t17}{t18}{t19}{t20}{t21}{t22}{t23}</T0>;
    $[43] = T0;
    $[44] = handleKeyDown;
    $[45] = t11;
    $[46] = t14;
    $[47] = t17;
    $[48] = t18;
    $[49] = t19;
    $[50] = t20;
    $[51] = t21;
    $[52] = t22;
    $[53] = t23;
    $[54] = t9;
    $[55] = t24;
  } else {
    t24 = $[55];
  }
  return t24;
}
