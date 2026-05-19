import type {
  BetaUsage,
  BetaServerToolUsage,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'

type RequiredUsage = Required<BetaUsage>
type NonNullableUsageFields = {
  [K in keyof RequiredUsage]: NonNullable<RequiredUsage[K]>
}

export type NonNullableUsage = Omit<
  NonNullableUsageFields,
  'server_tool_use'
> & {
  server_tool_use: Required<BetaServerToolUsage>
}
