// Cherry-picked types from openclaude src/types/message.ts referenced
// by the wholesale-ported search dialogs.
//
// openclaude's full file (25 LOC + transitive Anthropic SDK shapes)
// declares the message-tree the rest of openclaude renders. AgenC's
// transcript layer has its own message model; only the structural
// shapes the search dialogs touch are reproduced here.

export interface RenderableMessage {
  readonly type: string;
  readonly message?: { readonly content?: ReadonlyArray<{ readonly type?: string }> };
}

export type NormalizedUserMessage = RenderableMessage;
