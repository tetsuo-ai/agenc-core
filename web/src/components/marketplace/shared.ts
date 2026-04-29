export function formatTimestamp(timestamp?: number) {
  if (!timestamp) return '--';
  return new Date(timestamp * 1000).toLocaleString();
}

export function formatCompact(value: string) {
  return value.length > 18 ? `${value.slice(0, 10)}...${value.slice(-6)}` : value;
}
