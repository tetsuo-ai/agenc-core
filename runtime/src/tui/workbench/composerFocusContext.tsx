import React, { createContext, useContext } from "react";

const WorkbenchComposerFocusContext = createContext<boolean | null>(null);

export function WorkbenchComposerFocusProvider({
  active,
  children,
}: {
  readonly active: boolean;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <WorkbenchComposerFocusContext.Provider value={active}>
      {children}
    </WorkbenchComposerFocusContext.Provider>
  );
}

export function useWorkbenchComposerFocus(): boolean | null {
  return useContext(WorkbenchComposerFocusContext);
}
