import { c as _c } from "react-compiler-runtime";
import chalk from 'chalk';
import * as React from 'react';
import { useState } from 'react';
import type { CommandResultDisplay } from '../../../commands.js';
import { useExitOnCtrlCDWithKeybindings } from 'src/tui/hooks/useExitOnCtrlCDWithKeybindings.js';
// @ts-expect-error Existing TUI bundler resolves extensionless imports in this agent-management subtree.
import { useMergedTools } from '../../hooks/useMergedTools';
import { Box, Text } from '../../ink.js';
import { useAppState, useSetAppState } from '../../state/AppState.js';
// @ts-expect-error Existing TUI bundler resolves extensionless imports in this agent-management subtree.
import { resolveAgentOverrides } from '../../../tools/AgentTool/agentDisplay';
import { type AgentDefinition, getActiveAgentsFromList } from 'src/tools/AgentTool/loadAgentsDir.js';
import { toError } from '../../../utils/errors.js';
import { logError } from '../../../utils/log.js';
// @ts-expect-error Existing TUI bundler resolves extensionless imports in this agent-management subtree.
import { Select } from '../CustomSelect/select';
// @ts-expect-error Existing TUI bundler resolves extensionless imports in this agent-management subtree.
import { Dialog } from '../design-system/Dialog';
// @ts-expect-error Existing TUI bundler resolves extensionless imports in this agent-management subtree.
import { AgentDetail } from './AgentDetail';
// @ts-expect-error Existing TUI bundler resolves extensionless imports in this agent-management subtree.
import { AgentEditor } from './AgentEditor';
// @ts-expect-error Existing TUI bundler resolves extensionless imports in this agent-management subtree.
import { AgentNavigationFooter, getAgentCloseFooterInstructions, getAgentDeleteFooterInstructions } from './AgentNavigationFooter';
// @ts-expect-error Existing TUI bundler resolves extensionless imports in this agent-management subtree.
import { AgentsList } from './AgentsList';
// @ts-expect-error Existing TUI bundler resolves extensionless imports in this agent-management subtree.
import { AgentDeleteFailureMessage, formatAgentDeleteFailureMessage } from './AgentDeleteFailure';
// @ts-expect-error Existing TUI bundler resolves extensionless imports in this agent-management subtree.
import { deleteAgentFromFile } from './agentFileUtils';
// @ts-expect-error Existing TUI bundler resolves extensionless imports in this agent-management subtree.
import { CreateAgentWizard } from './new-agent-creation/CreateAgentWizard';
import type { ModeState } from './types.js';
type Tools = unknown;
type Props = {
  tools: Tools;
  onExit: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
};
export function AgentsMenu(t0: Props): React.ReactNode {
  const $ = _c(157);
  const {
    tools,
    onExit
  } = t0;
  let t1: ModeState;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = {
      mode: "list-agents",
      source: "all"
    };
    $[0] = t1;
  } else {
    t1 = $[0];
  }
  const [modeState, setModeState] = useState<ModeState>(t1);
  const agentDefinitions = useAppState(_temp);
  const mcpTools = useAppState(_temp2);
  const toolPermissionContext = useAppState(_temp3);
  const setAppState = useSetAppState();
  const {
    allAgents,
    activeAgents: agents
  } = agentDefinitions;
  let t2: string[];
  if ($[1] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = [];
    $[1] = t2;
  } else {
    t2 = $[1];
  }
  const [changes, setChanges] = useState<string[]>(t2);
  const [deleteFailureMessage, setDeleteFailureMessage] = useState<string | null>(null);
  const mergedTools = useMergedTools(tools, mcpTools, toolPermissionContext);
  useExitOnCtrlCDWithKeybindings();
  let t3;
  if ($[2] !== allAgents) {
    t3 = allAgents.filter(_temp4);
    $[2] = allAgents;
    $[3] = t3;
  } else {
    t3 = $[3];
  }
  let t4;
  if ($[4] !== allAgents) {
    t4 = allAgents.filter(_temp5);
    $[4] = allAgents;
    $[5] = t4;
  } else {
    t4 = $[5];
  }
  let t5;
  if ($[6] !== allAgents) {
    t5 = allAgents.filter(_temp6);
    $[6] = allAgents;
    $[7] = t5;
  } else {
    t5 = $[7];
  }
  let t6;
  if ($[8] !== allAgents) {
    t6 = allAgents.filter(_temp7);
    $[8] = allAgents;
    $[9] = t6;
  } else {
    t6 = $[9];
  }
  let t7;
  if ($[10] !== allAgents) {
    t7 = allAgents.filter(_temp8);
    $[10] = allAgents;
    $[11] = t7;
  } else {
    t7 = $[11];
  }
  let t8;
  if ($[12] !== allAgents) {
    t8 = allAgents.filter(_temp9);
    $[12] = allAgents;
    $[13] = t8;
  } else {
    t8 = $[13];
  }
  let t9;
  if ($[14] !== allAgents) {
    t9 = allAgents.filter(_temp0);
    $[14] = allAgents;
    $[15] = t9;
  } else {
    t9 = $[15];
  }
  let t10;
  if ($[16] !== allAgents || $[17] !== t3 || $[18] !== t4 || $[19] !== t5 || $[20] !== t6 || $[21] !== t7 || $[22] !== t8 || $[23] !== t9) {
    t10 = {
      "built-in": t3,
      userSettings: t4,
      projectSettings: t5,
      policySettings: t6,
      localSettings: t7,
      flagSettings: t8,
      plugin: t9,
      all: allAgents
    };
    $[16] = allAgents;
    $[17] = t3;
    $[18] = t4;
    $[19] = t5;
    $[20] = t6;
    $[21] = t7;
    $[22] = t8;
    $[23] = t9;
    $[24] = t10;
  } else {
    t10 = $[24];
  }
  const agentsBySource = t10;
  let t11;
  if ($[25] === Symbol.for("react.memo_cache_sentinel")) {
    t11 = (message: string) => {
      setChanges((prev: string[]) => [...prev, message]);
      setModeState({
        mode: "list-agents",
        source: "all"
      });
    };
    $[25] = t11;
  } else {
    t11 = $[25];
  }
  const handleAgentCreated = t11;
  let t12;
  if ($[26] !== setAppState) {
    t12 = async (agent: AgentDefinition) => {
      ;
      setDeleteFailureMessage(null);
      try {
        await deleteAgentFromFile(agent);
        setAppState((state: any) => {
          const allAgents_0 = state.agentDefinitions.allAgents.filter((a_6: AgentDefinition) => !(a_6.agentType === agent.agentType && a_6.source === agent.source));
          return {
            ...state,
            agentDefinitions: {
              ...state.agentDefinitions,
              allAgents: allAgents_0,
              activeAgents: getActiveAgentsFromList(allAgents_0)
            }
          };
        });
        setChanges((prev_0: string[]) => [...prev_0, `Deleted agent: ${chalk.bold(agent.agentType)}`]);
        setModeState({
          mode: "list-agents",
          source: "all"
        });
      } catch (t13) {
        const error = t13;
        logError(toError(error));
        setDeleteFailureMessage(formatAgentDeleteFailureMessage(agent, error));
      }
    };
    $[26] = setAppState;
    $[27] = t12;
  } else {
    t12 = $[27];
  }
  const handleAgentDeleted = t12;
  switch (modeState.mode) {
    case "list-agents":
      {
        let t13;
        if ($[28] !== agentsBySource || $[29] !== modeState.source) {
          t13 = modeState.source === "all" ? [...agentsBySource["built-in"], ...agentsBySource.userSettings, ...agentsBySource.projectSettings, ...agentsBySource.localSettings, ...agentsBySource.policySettings, ...agentsBySource.flagSettings, ...agentsBySource.plugin] : agentsBySource[modeState.source];
          $[28] = agentsBySource;
          $[29] = modeState.source;
          $[30] = t13;
        } else {
          t13 = $[30];
        }
        const agentsToShow = t13;
        let t14;
        if ($[31] !== agents || $[32] !== agentsToShow) {
          t14 = resolveAgentOverrides(agentsToShow, agents);
          $[31] = agents;
          $[32] = agentsToShow;
          $[33] = t14;
        } else {
          t14 = $[33];
        }
        const allResolved = t14;
        const resolvedAgents = allResolved;
        let t15;
        if ($[34] !== changes || $[35] !== onExit) {
          t15 = () => {
            const exitMessage = changes.length > 0 ? `Agent changes:\n${changes.join("\n")}` : undefined;
            onExit(exitMessage ?? "Agents dialog dismissed", {
              display: changes.length === 0 ? "system" : undefined
            });
          };
          $[34] = changes;
          $[35] = onExit;
          $[36] = t15;
        } else {
          t15 = $[36];
        }
        let t16;
        if ($[37] !== modeState) {
          t16 = (agent_0: AgentDefinition) => setModeState({
            mode: "agent-menu",
            agent: agent_0,
            previousMode: modeState
          });
          $[37] = modeState;
          $[38] = t16;
        } else {
          t16 = $[38];
        }
        let t17;
        if ($[39] === Symbol.for("react.memo_cache_sentinel")) {
          t17 = () => setModeState({
            mode: "create-agent"
          });
          $[39] = t17;
        } else {
          t17 = $[39];
        }
        let t18;
        if ($[40] !== changes || $[41] !== modeState.source || $[42] !== resolvedAgents || $[43] !== t15 || $[44] !== t16) {
          t18 = <AgentsList source={modeState.source} agents={resolvedAgents} onBack={t15} onSelect={t16} onCreateNew={t17} changes={changes} />;
          $[40] = changes;
          $[41] = modeState.source;
          $[42] = resolvedAgents;
          $[43] = t15;
          $[44] = t16;
          $[45] = t18;
        } else {
          t18 = $[45];
        }
        let t19;
        if ($[46] === Symbol.for("react.memo_cache_sentinel")) {
          t19 = <AgentNavigationFooter instructions={getAgentCloseFooterInstructions()} />;
          $[46] = t19;
        } else {
          t19 = $[46];
        }
        let t20;
        if ($[47] !== t18) {
          t20 = <>{t18}{t19}</>;
          $[47] = t18;
          $[48] = t20;
        } else {
          t20 = $[48];
        }
        return t20;
      }
    case "create-agent":
      {
        let t13;
        if ($[49] === Symbol.for("react.memo_cache_sentinel")) {
          t13 = () => setModeState({
            mode: "list-agents",
            source: "all"
          });
          $[49] = t13;
        } else {
          t13 = $[49];
        }
        let t14;
        if ($[50] !== agents || $[51] !== mergedTools) {
          t14 = <CreateAgentWizard tools={mergedTools} existingAgents={agents} onComplete={handleAgentCreated} onCancel={t13} />;
          $[50] = agents;
          $[51] = mergedTools;
          $[52] = t14;
        } else {
          t14 = $[52];
        }
        return t14;
      }
    case "agent-menu":
      {
        let t13;
        if ($[53] !== allAgents || $[54] !== modeState.agent.agentType || $[55] !== modeState.agent.source) {
          let t14;
          if ($[57] !== modeState.agent.agentType || $[58] !== modeState.agent.source) {
            t14 = (a_9: AgentDefinition) => a_9.agentType === modeState.agent.agentType && a_9.source === modeState.agent.source;
            $[57] = modeState.agent.agentType;
            $[58] = modeState.agent.source;
            $[59] = t14;
          } else {
            t14 = $[59];
          }
          t13 = allAgents.find(t14);
          $[53] = allAgents;
          $[54] = modeState.agent.agentType;
          $[55] = modeState.agent.source;
          $[56] = t13;
        } else {
          t13 = $[56];
        }
        const freshAgent_1 = t13;
        const agentToUse = freshAgent_1 || modeState.agent;
        const isEditable = agentToUse.source !== "built-in" && agentToUse.source !== "plugin" && agentToUse.source !== "flagSettings";
        let t14;
        if ($[60] === Symbol.for("react.memo_cache_sentinel")) {
          t14 = {
            label: "View agent",
            value: "view"
          };
          $[60] = t14;
        } else {
          t14 = $[60];
        }
        let t15;
        if ($[61] !== isEditable) {
          t15 = isEditable ? [{
            label: "Edit agent",
            value: "edit"
          }, {
            label: "Delete agent",
            value: "delete"
          }] : [];
          $[61] = isEditable;
          $[62] = t15;
        } else {
          t15 = $[62];
        }
        let t16;
        if ($[63] === Symbol.for("react.memo_cache_sentinel")) {
          t16 = {
            label: "Back",
            value: "back"
          };
          $[63] = t16;
        } else {
          t16 = $[63];
        }
        let t17;
        if ($[64] !== t15) {
          t17 = [t14, ...t15, t16];
          $[64] = t15;
          $[65] = t17;
        } else {
          t17 = $[65];
        }
        const menuItems = t17;
        let t18;
        if ($[66] !== agentToUse || $[67] !== modeState) {
          t18 = (value_0: string) => {
            bb129: switch (value_0) {
              case "view":
                {
                  setModeState({
                    mode: "view-agent",
                    agent: agentToUse,
                    previousMode: modeState.previousMode
                  });
                  break bb129;
                }
              case "edit":
                {
                  setModeState({
                    mode: "edit-agent",
                    agent: agentToUse,
                    previousMode: modeState
                  });
                  break bb129;
                }
              case "delete":
                {
                  setDeleteFailureMessage(null);
                  setModeState({
                    mode: "delete-confirm",
                    agent: agentToUse,
                    previousMode: modeState
                  });
                  break bb129;
                }
              case "back":
                {
                  setModeState(modeState.previousMode);
                }
            }
          };
          $[66] = agentToUse;
          $[67] = modeState;
          $[68] = t18;
        } else {
          t18 = $[68];
        }
        const handleMenuSelect = t18;
        let t19;
        if ($[69] !== modeState.previousMode) {
          t19 = () => setModeState(modeState.previousMode);
          $[69] = modeState.previousMode;
          $[70] = t19;
        } else {
          t19 = $[70];
        }
        let t20;
        if ($[71] !== modeState.previousMode) {
          t20 = () => setModeState(modeState.previousMode);
          $[71] = modeState.previousMode;
          $[72] = t20;
        } else {
          t20 = $[72];
        }
        let t21;
        if ($[73] !== handleMenuSelect || $[74] !== menuItems || $[75] !== t20) {
          t21 = <Select options={menuItems} onChange={handleMenuSelect} onCancel={t20} />;
          $[73] = handleMenuSelect;
          $[74] = menuItems;
          $[75] = t20;
          $[76] = t21;
        } else {
          t21 = $[76];
        }
        let t22;
        if ($[77] !== changes) {
          t22 = changes.length > 0 && <Box marginTop={1}><Text dimColor={true}>{changes[changes.length - 1]}</Text></Box>;
          $[77] = changes;
          $[78] = t22;
        } else {
          t22 = $[78];
        }
        let t23;
        if ($[79] !== t21 || $[80] !== t22) {
          t23 = <Box flexDirection="column">{t21}{t22}</Box>;
          $[79] = t21;
          $[80] = t22;
          $[81] = t23;
        } else {
          t23 = $[81];
        }
        let t24;
        if ($[82] !== modeState.agent.agentType || $[83] !== t19 || $[84] !== t23) {
          t24 = <Dialog title={modeState.agent.agentType} onCancel={t19} hideInputGuide={true}>{t23}</Dialog>;
          $[82] = modeState.agent.agentType;
          $[83] = t19;
          $[84] = t23;
          $[85] = t24;
        } else {
          t24 = $[85];
        }
        let t25;
        if ($[86] === Symbol.for("react.memo_cache_sentinel")) {
          t25 = <AgentNavigationFooter />;
          $[86] = t25;
        } else {
          t25 = $[86];
        }
        let t26;
        if ($[87] !== t24) {
          t26 = <>{t24}{t25}</>;
          $[87] = t24;
          $[88] = t26;
        } else {
          t26 = $[88];
        }
        return t26;
      }
    case "view-agent":
      {
        let t13;
        if ($[89] !== allAgents || $[90] !== modeState.agent) {
          let t14;
          if ($[92] !== modeState.agent) {
            t14 = (a_8: AgentDefinition) => a_8.agentType === modeState.agent.agentType && a_8.source === modeState.agent.source;
            $[92] = modeState.agent;
            $[93] = t14;
          } else {
            t14 = $[93];
          }
          t13 = allAgents.find(t14);
          $[89] = allAgents;
          $[90] = modeState.agent;
          $[91] = t13;
        } else {
          t13 = $[91];
        }
        const freshAgent_0 = t13;
        const agentToDisplay = freshAgent_0 || modeState.agent;
        let t14;
        if ($[94] !== agentToDisplay || $[95] !== modeState.previousMode) {
          t14 = () => setModeState({
            mode: "agent-menu",
            agent: agentToDisplay,
            previousMode: modeState.previousMode
          });
          $[94] = agentToDisplay;
          $[95] = modeState.previousMode;
          $[96] = t14;
        } else {
          t14 = $[96];
        }
        let t15;
        if ($[97] !== agentToDisplay || $[98] !== modeState.previousMode) {
          t15 = () => setModeState({
            mode: "agent-menu",
            agent: agentToDisplay,
            previousMode: modeState.previousMode
          });
          $[97] = agentToDisplay;
          $[98] = modeState.previousMode;
          $[99] = t15;
        } else {
          t15 = $[99];
        }
        let t16;
        if ($[100] !== agentToDisplay || $[101] !== allAgents || $[102] !== mergedTools || $[103] !== t15) {
          t16 = <AgentDetail agent={agentToDisplay} tools={mergedTools} allAgents={allAgents} onBack={t15} />;
          $[100] = agentToDisplay;
          $[101] = allAgents;
          $[102] = mergedTools;
          $[103] = t15;
          $[104] = t16;
        } else {
          t16 = $[104];
        }
        let t17;
        if ($[105] !== agentToDisplay.agentType || $[106] !== t14 || $[107] !== t16) {
          t17 = <Dialog title={agentToDisplay.agentType} onCancel={t14} hideInputGuide={true}>{t16}</Dialog>;
          $[105] = agentToDisplay.agentType;
          $[106] = t14;
          $[107] = t16;
          $[108] = t17;
        } else {
          t17 = $[108];
        }
        let t18;
        if ($[109] === Symbol.for("react.memo_cache_sentinel")) {
          t18 = <AgentNavigationFooter instructions="Press Enter or Esc to go back" />;
          $[109] = t18;
        } else {
          t18 = $[109];
        }
        let t19;
        if ($[110] !== t17) {
          t19 = <>{t17}{t18}</>;
          $[110] = t17;
          $[111] = t19;
        } else {
          t19 = $[111];
        }
        return t19;
      }
    case "delete-confirm":
      {
        let t13;
        if ($[112] === Symbol.for("react.memo_cache_sentinel")) {
          t13 = [{
            label: "Yes, delete",
            value: "yes"
          }, {
            label: "No, cancel",
            value: "no"
          }];
          $[112] = t13;
        } else {
          t13 = $[112];
        }
        const deleteOptions = t13;
        let t14;
        if ($[113] !== modeState) {
          t14 = () => {
            setDeleteFailureMessage(null);
            if ("previousMode" in modeState) {
              setModeState(modeState.previousMode);
            }
          };
          $[113] = modeState;
          $[114] = t14;
        } else {
          t14 = $[114];
        }
        let t15;
        if ($[115] !== modeState.agent.agentType) {
          t15 = <Text>Are you sure you want to delete the agent{" "}<Text bold={true}>{modeState.agent.agentType}</Text>?</Text>;
          $[115] = modeState.agent.agentType;
          $[116] = t15;
        } else {
          t15 = $[116];
        }
        let t16;
        if ($[117] !== modeState.agent.source) {
          t16 = <Box marginTop={1}><Text dimColor={true}>Source: {modeState.agent.source}</Text></Box>;
          $[117] = modeState.agent.source;
          $[118] = t16;
        } else {
          t16 = $[118];
        }
        let t17;
        if ($[119] !== handleAgentDeleted || $[120] !== modeState) {
          t17 = (value: string) => {
            if (value === "yes") {
              handleAgentDeleted(modeState.agent);
            } else {
              setDeleteFailureMessage(null);
              if ("previousMode" in modeState) {
                setModeState(modeState.previousMode);
              }
            }
          };
          $[119] = handleAgentDeleted;
          $[120] = modeState;
          $[121] = t17;
        } else {
          t17 = $[121];
        }
        let t18;
        if ($[122] !== modeState) {
          t18 = () => {
            setDeleteFailureMessage(null);
            if ("previousMode" in modeState) {
              setModeState(modeState.previousMode);
            }
          };
          $[122] = modeState;
          $[123] = t18;
        } else {
          t18 = $[123];
        }
        let t19;
        if ($[124] !== t17 || $[125] !== t18) {
          t19 = <Box marginTop={1}><Select options={deleteOptions} onChange={t17} onCancel={t18} /></Box>;
          $[124] = t17;
          $[125] = t18;
          $[126] = t19;
        } else {
          t19 = $[126];
        }
        const deleteFailure = deleteFailureMessage && <AgentDeleteFailureMessage message={deleteFailureMessage} />;
        const t20 = <Dialog title="Delete agent" onCancel={t14} color="error">{t15}{t16}{deleteFailure}{t19}</Dialog>;
        let t21;
        if ($[132] === Symbol.for("react.memo_cache_sentinel")) {
          t21 = <AgentNavigationFooter instructions={getAgentDeleteFooterInstructions()} />;
          $[132] = t21;
        } else {
          t21 = $[132];
        }
        let t22;
        if ($[133] !== t20) {
          t22 = <>{t20}{t21}</>;
          $[133] = t20;
          $[134] = t22;
        } else {
          t22 = $[134];
        }
        return t22;
      }
    case "edit-agent":
      {
        let t13;
        if ($[135] !== allAgents || $[136] !== modeState.agent) {
          let t14;
          if ($[138] !== modeState.agent) {
            t14 = (a_7: AgentDefinition) => a_7.agentType === modeState.agent.agentType && a_7.source === modeState.agent.source;
            $[138] = modeState.agent;
            $[139] = t14;
          } else {
            t14 = $[139];
          }
          t13 = allAgents.find(t14);
          $[135] = allAgents;
          $[136] = modeState.agent;
          $[137] = t13;
        } else {
          t13 = $[137];
        }
        const freshAgent = t13;
        const agentToEdit = freshAgent || modeState.agent;
        const t14 = `Edit agent: ${agentToEdit.agentType}`;
        let t15;
        if ($[140] !== modeState.previousMode) {
          t15 = () => setModeState(modeState.previousMode);
          $[140] = modeState.previousMode;
          $[141] = t15;
        } else {
          t15 = $[141];
        }
        let t16;
        let t17;
        if ($[142] !== modeState.previousMode) {
          t16 = (message_0: string) => {
            handleAgentCreated(message_0);
            setModeState(modeState.previousMode);
          };
          t17 = () => setModeState(modeState.previousMode);
          $[142] = modeState.previousMode;
          $[143] = t16;
          $[144] = t17;
        } else {
          t16 = $[143];
          t17 = $[144];
        }
        let t18;
        if ($[145] !== agentToEdit || $[146] !== mergedTools || $[147] !== t16 || $[148] !== t17) {
          t18 = <AgentEditor agent={agentToEdit} tools={mergedTools} onSaved={t16} onBack={t17} />;
          $[145] = agentToEdit;
          $[146] = mergedTools;
          $[147] = t16;
          $[148] = t17;
          $[149] = t18;
        } else {
          t18 = $[149];
        }
        let t19;
        if ($[150] !== t14 || $[151] !== t15 || $[152] !== t18) {
          t19 = <Dialog title={t14} onCancel={t15} hideInputGuide={true}>{t18}</Dialog>;
          $[150] = t14;
          $[151] = t15;
          $[152] = t18;
          $[153] = t19;
        } else {
          t19 = $[153];
        }
        let t20;
        if ($[154] === Symbol.for("react.memo_cache_sentinel")) {
          t20 = <AgentNavigationFooter />;
          $[154] = t20;
        } else {
          t20 = $[154];
        }
        let t21;
        if ($[155] !== t19) {
          t21 = <>{t19}{t20}</>;
          $[155] = t19;
          $[156] = t21;
        } else {
          t21 = $[156];
        }
        return t21;
      }
    default:
      {
        return null;
      }
  }
}
function _temp0(a_5: AgentDefinition): boolean {
  return (a_5.source as string) === "plugin";
}
function _temp9(a_4: AgentDefinition): boolean {
  return (a_4.source as string) === "flagSettings";
}
function _temp8(a_3: AgentDefinition): boolean {
  return (a_3.source as string) === "localSettings";
}
function _temp7(a_2: AgentDefinition): boolean {
  return (a_2.source as string) === "policySettings";
}
function _temp6(a_1: AgentDefinition): boolean {
  return (a_1.source as string) === "projectSettings";
}
function _temp5(a_0: AgentDefinition): boolean {
  return (a_0.source as string) === "userSettings";
}
function _temp4(a: AgentDefinition): boolean {
  return (a.source as string) === "built-in";
}
function _temp3(s_1: any): unknown {
  return s_1.toolPermissionContext;
}
function _temp2(s_0: any): unknown {
  return s_0.mcp.tools;
}
function _temp(s: any): {
  allAgents: AgentDefinition[];
  activeAgents: AgentDefinition[];
} {
  return s.agentDefinitions;
}
