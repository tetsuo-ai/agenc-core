import chalk from 'chalk';
import React, { type ReactNode, useCallback, useState } from 'react';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from '../../../../../services/analytics/index.js';
import { useSetAppState } from '../../../../state/AppState.js';
import type { Tools } from '../../../../../tools/Tool';
import type { AgentDefinition } from 'src/tools/AgentTool/loadAgentsDir.js';
import { getActiveAgentsFromList } from 'src/tools/AgentTool/loadAgentsDir.js';
import { editFileInEditor } from '../../../../../utils/promptEditor.js'; // upstream-import: keep target is owned by another Z-PURGE item
import { useWizard } from '../../../wizard/index';
import { getNewAgentFilePath, saveAgentToFile } from '../../agentFileUtils';
import type { AgentWizardData } from '../types';
import { ConfirmStep } from './ConfirmStep';
type Props = {
  tools: Tools;
  existingAgents: AgentDefinition[];
  onComplete: (message: string) => void;
};
export function ConfirmStepWrapper({
  tools,
  existingAgents,
  onComplete
}: Props): ReactNode {
  const {
    wizardData
  } = useWizard<AgentWizardData>();
  const [saveError, setSaveError] = useState<string | null>(null);
  const setAppState = useSetAppState();
  const saveAgent = useCallback(async (openInEditor: boolean): Promise<void> => {
    if (!wizardData?.finalAgent) return;
    try {
      await saveAgentToFile(wizardData.location!, wizardData.finalAgent.agentType, wizardData.finalAgent.whenToUse, wizardData.finalAgent.tools, wizardData.finalAgent.getSystemPrompt(), true, wizardData.finalAgent.color, wizardData.finalAgent.model, wizardData.finalAgent.memory);
      setAppState(state => {
        if (!wizardData.finalAgent) return state;
        const allAgents = state.agentDefinitions.allAgents.concat(wizardData.finalAgent);
        return {
          ...state,
          agentDefinitions: {
            ...state.agentDefinitions,
            activeAgents: getActiveAgentsFromList(allAgents),
            allAgents
          }
        };
      });
      if (openInEditor) {
        const filePath = getNewAgentFilePath({
          source: wizardData.location!,
          agentType: wizardData.finalAgent.agentType
        });
        await editFileInEditor(filePath);
      }
      logEvent('tengu_agent_created', {
        agent_type: wizardData.finalAgent.agentType,
        generation_method: wizardData.wasGenerated ? 'generated' : 'manual',
        source: wizardData.location!,
        tool_count: wizardData.finalAgent.tools?.length ?? 'all',
        has_custom_model: !!wizardData.finalAgent.model,
        has_custom_color: !!wizardData.finalAgent.color,
        has_memory: !!wizardData.finalAgent.memory,
        memory_scope: wizardData.finalAgent.memory ?? 'none',
        ...(openInEditor ? {
          opened_in_editor: true
        } : {})
      } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS);
      const message = openInEditor ? `Created agent: ${chalk.bold(wizardData.finalAgent.agentType)} and opened in editor. ` + `If you made edits, restart to load the latest version.` : `Created agent: ${chalk.bold(wizardData.finalAgent.agentType)}`;
      onComplete(message);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save agent');
    }
  }, [wizardData, onComplete, setAppState]);
  const handleSave = useCallback(() => saveAgent(false), [saveAgent]);
  const handleSaveAndEdit = useCallback(() => saveAgent(true), [saveAgent]);
  return <ConfirmStep tools={tools} existingAgents={existingAgents} onSave={handleSave} onSaveAndEdit={handleSaveAndEdit} error={saveError} />;
}
