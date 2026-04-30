// Cherry-picked HistoryEntry + PastedContent types for the wholesale-
// ported search dialogs.
//
// openclaude src/utils/config.ts is 1884 LOC of config-store
// machinery (project + global config, MCP server registration,
// allowed-tools allowlist, etc.) that is product-runtime specific.
// AgenC has its own config layer; this file only reproduces the
// structural type shapes the search dialogs consume.

export type PastedContent = {
  readonly id: number;
  readonly type: "text" | "image";
  readonly content: string;
};

export interface HistoryEntry {
  display: string;
  pastedContents: Record<number, PastedContent>;
}
