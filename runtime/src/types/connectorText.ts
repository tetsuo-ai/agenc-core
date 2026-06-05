export type ConnectorTextBlock = {
  type: 'connector_text'
  connector_text: string
  connector?: string
  // Populated from signature_delta events when CONNECTOR_TEXT streaming is
  // enabled (see services/api/anthropic.ts signature_delta handling).
  signature?: string
}

export type ConnectorTextDelta = {
  type: 'connector_text_delta'
  connector_text: string
  connector?: string
}

export function isConnectorTextBlock(
  value: unknown,
): value is ConnectorTextBlock {
  return (
    typeof value === 'object' &&
    value !== null &&
    'connector_text' in value &&
    typeof (value as { connector_text?: unknown }).connector_text === 'string'
  )
}
