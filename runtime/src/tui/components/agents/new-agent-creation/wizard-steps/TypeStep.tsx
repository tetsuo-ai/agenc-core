import { c as _c } from "react-compiler-runtime";
import React, { type ReactNode, useState } from 'react';
import { Box, Text } from '../../../../ink.js';
import { useKeybinding } from '../../../../keybindings/useKeybinding.js';
import type { AgentDefinition } from 'src/tools/AgentTool/loadAgentsDir.js';
import { ConfigurableShortcutHint } from '../../../ConfigurableShortcutHint';
import { Byline } from '../../../design-system/Byline';
import { KeyboardShortcutHint } from '../../../design-system/KeyboardShortcutHint';
import TextInput from '../../../TextInput';
import { useWizard } from '../../../wizard/index';
import { WizardDialogLayout } from '../../../wizard/WizardDialogLayout';
import { useAgentWizardInputColumns } from '../layout.js';
import { validateAgentType } from '../../validateAgent';
import type { AgentWizardData } from '../types';
type Props = {
  existingAgents: AgentDefinition[];
};
export function TypeStep(_props) {
  const $ = _c(15);
  const {
    goNext,
    goBack,
    updateWizardData,
    wizardData
  } = useWizard();
  const [agentType, setAgentType] = useState(wizardData.agentType || "");
  const [error, setError] = useState(null);
  const [cursorOffset, setCursorOffset] = useState(agentType.length);
  const inputColumns = useAgentWizardInputColumns(60);
  let t0;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t0 = {
      context: "Settings"
    };
    $[0] = t0;
  } else {
    t0 = $[0];
  }
  useKeybinding("confirm:no", goBack, t0);
  let t1;
  if ($[1] !== goNext || $[2] !== updateWizardData) {
    t1 = value => {
      const trimmedValue = value.trim();
      const validationError = validateAgentType(trimmedValue);
      if (validationError) {
        setError(validationError);
        return;
      }
      setError(null);
      updateWizardData({
        agentType: trimmedValue
      });
      goNext();
    };
    $[1] = goNext;
    $[2] = updateWizardData;
    $[3] = t1;
  } else {
    t1 = $[3];
  }
  const handleSubmit = t1;
  let t2;
  if ($[4] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = <Byline><KeyboardShortcutHint shortcut="Type" action="enter text" /><KeyboardShortcutHint shortcut="Enter" action="continue" /><ConfigurableShortcutHint action="confirm:no" context="Settings" fallback="Esc" description="go back" /></Byline>;
    $[4] = t2;
  } else {
    t2 = $[4];
  }
  let t3;
  if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
    t3 = <Text>Enter a unique identifier for your agent:</Text>;
    $[5] = t3;
  } else {
    t3 = $[5];
  }
  const t4 = <Box marginTop={1}><TextInput value={agentType} onChange={setAgentType} onSubmit={handleSubmit} placeholder="e.g., test-runner, tech-lead, etc" columns={inputColumns} cursorOffset={cursorOffset} onChangeCursorOffset={setCursorOffset} focus={true} showCursor={true} /></Box>;
  let t5;
  if ($[10] !== error) {
    t5 = error && <Box marginTop={1}><Text color="error">{error}</Text></Box>;
    $[10] = error;
    $[11] = t5;
  } else {
    t5 = $[11];
  }
  let t6;
  if ($[12] !== t4 || $[13] !== t5) {
    t6 = <WizardDialogLayout subtitle="Agent type (identifier)" footerText={t2}><Box flexDirection="column">{t3}{t4}{t5}</Box></WizardDialogLayout>;
    $[12] = t4;
    $[13] = t5;
    $[14] = t6;
  } else {
    t6 = $[14];
  }
  return t6;
}
