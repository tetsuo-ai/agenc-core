import { c as _c } from "react-compiler-runtime";
// biome-ignore-all assist/source/organizeImports: internal-only import markers must not be reordered
import * as React from 'react';
import { Suspense, useState } from 'react';
import { useKeybinding } from '../../keybindings/useKeybinding.js';
import { useExitOnCtrlCDWithKeybindings } from 'src/tui/hooks/useExitOnCtrlCDWithKeybindings.js';
// @ts-expect-error Existing TUI bundler resolves extensionless imports in this Settings subtree.
import { useTerminalSize } from '../../hooks/useTerminalSize';
// @ts-expect-error Existing TUI bundler resolves extensionless imports in this Settings subtree.
import { useIsInsideModal, useModalOrTerminalSize } from '../../context/modalContext';
// @ts-expect-error Existing TUI bundler resolves extensionless imports in this Settings subtree.
import { Pane } from '../design-system/Pane';
// @ts-expect-error Existing TUI bundler resolves extensionless imports in this Settings subtree.
import { Tabs, Tab } from '../design-system/Tabs';
// @ts-expect-error Existing TUI bundler resolves extensionless imports in this Settings subtree.
import { Status, buildDiagnostics } from './Status';
// @ts-expect-error Existing TUI bundler resolves extensionless imports in this Settings subtree.
import { Config } from './Config';
// @ts-expect-error Existing TUI bundler resolves extensionless imports in this Settings subtree.
import { Usage } from './Usage';
import { calculateSettingsContentHeight } from './layout.js';
import { SettingsConfigLoadingState } from './LoadingState.js';
import type { LocalJSXCommandContext, CommandResultDisplay } from '../../../commands.js';
type Props = {
  onClose: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
  context: LocalJSXCommandContext;
  defaultTab: 'Status' | 'Config' | 'Usage';
};
export function Settings(t0: Props): React.ReactNode {
  const $ = _c(25);
  const {
    onClose,
    context,
    defaultTab
  } = t0;
  const [selectedTab, setSelectedTab] = useState(defaultTab);
  const [tabsHidden, setTabsHidden] = useState(false);
  const [configOwnsEsc, setConfigOwnsEsc] = useState(false);
  const insideModal = useIsInsideModal();
  const {
    rows
  } = useModalOrTerminalSize(useTerminalSize());
  const contentHeight = calculateSettingsContentHeight(rows, insideModal);
  const [diagnosticsPromise] = useState(_temp2);
  useExitOnCtrlCDWithKeybindings();
  let t1;
  if ($[0] !== onClose || $[1] !== tabsHidden) {
    t1 = () => {
      if (tabsHidden) {
        return;
      }
      onClose("Status dialog dismissed", {
        display: "system"
      });
    };
    $[0] = onClose;
    $[1] = tabsHidden;
    $[2] = t1;
  } else {
    t1 = $[2];
  }
  const handleEscape = t1;
  const t2 = !tabsHidden && !(selectedTab === "Config" && configOwnsEsc);
  let t3;
  if ($[3] !== t2) {
    t3 = {
      context: "Settings",
      isActive: t2
    };
    $[3] = t2;
    $[4] = t3;
  } else {
    t3 = $[4];
  }
  useKeybinding("confirm:no", handleEscape, t3);
  let t4;
  if ($[5] !== context || $[6] !== diagnosticsPromise) {
    t4 = <Tab key="status" title="Status"><Status context={context} diagnosticsPromise={diagnosticsPromise} /></Tab>;
    $[5] = context;
    $[6] = diagnosticsPromise;
    $[7] = t4;
  } else {
    t4 = $[7];
  }
  let t5;
  if ($[8] !== contentHeight || $[9] !== context || $[10] !== onClose) {
    t5 = <Tab key="config" title="Config"><Suspense fallback={<SettingsConfigLoadingState />}><Config context={context} onClose={onClose} setTabsHidden={setTabsHidden} onIsSearchModeChange={setConfigOwnsEsc} contentHeight={contentHeight} /></Suspense></Tab>;
    $[8] = contentHeight;
    $[9] = context;
    $[10] = onClose;
    $[11] = t5;
  } else {
    t5 = $[11];
  }
  let t6;
  if ($[12] === Symbol.for("react.memo_cache_sentinel")) {
    t6 = <Tab key="usage" title="Usage"><Usage /></Tab>;
    $[12] = t6;
  } else {
    t6 = $[12];
  }
  let t8;
  if ($[13] !== t4 || $[14] !== t5 || $[15] !== t6) {
    t8 = [t4, t5, t6];
    $[13] = t4;
    $[14] = t5;
    $[15] = t6;
    $[16] = t8;
  } else {
    t8 = $[16];
  }
  const tabs = t8;
  const t9 = defaultTab !== "Config";
  const t10 = tabsHidden || insideModal ? undefined : contentHeight;
  let t11;
  if ($[19] !== selectedTab || $[20] !== t10 || $[21] !== t9 || $[22] !== tabs || $[23] !== tabsHidden) {
    t11 = <Pane color="permission"><Tabs color="permission" selectedTab={selectedTab} onTabChange={setSelectedTab} hidden={tabsHidden} initialHeaderFocused={t9} contentHeight={t10}>{tabs}</Tabs></Pane>;
    $[19] = selectedTab;
    $[20] = t10;
    $[21] = t9;
    $[22] = tabs;
    $[23] = tabsHidden;
    $[24] = t11;
  } else {
    t11 = $[24];
  }
  return t11;
}
function _temp2() {
  return buildDiagnostics().catch(_temp);
}
function _temp() {
  return [];
}
