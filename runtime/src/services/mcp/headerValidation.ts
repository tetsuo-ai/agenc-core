const MCP_MAX_HEADERS = 64
const MCP_MAX_HEADER_NAME_LENGTH = 128
const MCP_MAX_HEADER_VALUE_BYTES = 8192

const HTTP_HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
// HTTP header values must not contain request-splitting control bytes.
// Reject HTAB too; MCP auth/header values should not need embedded controls.
const CONTROL_BYTE_PATTERN = /[\x00-\x1f\x7f]/

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function validateMcpHeaderName(name: string, source: string): void {
  if (name.length === 0) {
    throw new Error(`${source}: header name cannot be empty`)
  }
  if (name.length > MCP_MAX_HEADER_NAME_LENGTH) {
    throw new Error(
      `${source}: header name "${name}" exceeds ${MCP_MAX_HEADER_NAME_LENGTH} characters`,
    )
  }
  if (!HTTP_HEADER_NAME_PATTERN.test(name)) {
    throw new Error(
      `${source}: invalid header name "${name}"; header names must be RFC token characters`,
    )
  }
}

function validateMcpHeaderValue(
  name: string,
  value: string,
  source: string,
): void {
  if (CONTROL_BYTE_PATTERN.test(value)) {
    throw new Error(
      `${source}: header "${name}" contains control characters`,
    )
  }
  const valueBytes = byteLength(value)
  if (valueBytes > MCP_MAX_HEADER_VALUE_BYTES) {
    throw new Error(
      `${source}: header "${name}" exceeds ${MCP_MAX_HEADER_VALUE_BYTES} bytes`,
    )
  }
}

export function validateMcpHeaders(
  headers: Record<string, string>,
  source: string,
): Record<string, string> {
  const entries = Object.entries(headers)
  if (entries.length > MCP_MAX_HEADERS) {
    throw new Error(
      `${source}: too many headers (${entries.length}; max ${MCP_MAX_HEADERS})`,
    )
  }

  const validated: Record<string, string> = {}
  const seenNames = new Set<string>()
  for (const [name, value] of entries) {
    validateMcpHeaderName(name, source)
    const normalizedName = name.toLowerCase()
    if (seenNames.has(normalizedName)) {
      throw new Error(`${source}: duplicate header name "${name}"`)
    }
    seenNames.add(normalizedName)
    validateMcpHeaderValue(name, value, source)
    validated[name] = value
  }
  return validated
}
