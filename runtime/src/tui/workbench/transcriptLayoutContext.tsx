import React, { createContext, useContext } from "react";

const WorkbenchTranscriptLayoutContext = createContext(false);
const AssistantMessageMetadataContext = createContext<{
  readonly timestamp?: string;
} | null>(null);

export function WorkbenchTranscriptLayoutProvider({
  children,
}: {
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <WorkbenchTranscriptLayoutContext.Provider value={true}>
      {children}
    </WorkbenchTranscriptLayoutContext.Provider>
  );
}

export function useWorkbenchTranscriptLayout(): boolean {
  return useContext(WorkbenchTranscriptLayoutContext);
}

/**
 * Carries metadata that belongs to the complete assistant message rather than
 * to its Markdown body. The workbench renderer uses this to place the AgenC
 * identity and timestamp in a dedicated header above the response.
 */
export function AssistantMessageMetadataProvider({
  timestamp,
  children,
}: {
  readonly timestamp?: string;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <AssistantMessageMetadataContext.Provider value={{ timestamp }}>
      {children}
    </AssistantMessageMetadataContext.Provider>
  );
}

export function useAssistantMessageMetadata(): {
  readonly timestamp?: string;
} | null {
  return useContext(AssistantMessageMetadataContext);
}
