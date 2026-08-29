export type ConnectorTextBlock = {
  type: 'connector_text'
  connector_text: string
  connector?: string
  // Populated from signature_delta events when connector-text streaming is
  // enabled.
  signature?: string
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
