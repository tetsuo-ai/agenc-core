export interface StableNodeDescription { readonly source: string; readonly sha256: string }
export function stableNodePath(home: string): string;
export function describeStableNode(home: string, source: string): StableNodeDescription;
export function installStableNode(home: string, description: StableNodeDescription,
  checkpoint?: (step: string) => void): string;
