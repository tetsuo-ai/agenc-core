/** Display only. Never use this label for dispatch, approval scope, or model input. */
export function toolDisplayName(name: string): string {
  const parts = name.startsWith('mcp__') ? name.slice(5).split('__')
    : name.startsWith('mcp.') ? name.slice(4).split('.') : [];
  if (parts.length >= 2) {
    return `${words(parts.slice(1).join(' '))} in ${words(parts[0]!, false)}`;
  }
  return words(name.replace(/^(?:system|functions)[.]/u, '')) || 'Tool';
}

function words(value: string, capitalize = true): string {
  const label = value.replace(/([a-z])([A-Z])/gu, '$1 $2').replace(/[_.-]+/gu, ' ').trim();
  return capitalize && label ? label[0]!.toUpperCase() + label.slice(1) : label;
}
