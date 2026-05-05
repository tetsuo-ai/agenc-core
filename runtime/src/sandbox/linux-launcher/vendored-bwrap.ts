export function vendoredBubblewrapAvailable(): boolean {
  return false;
}

export function vendoredBubblewrapReason(): string {
  return "AgenC's TypeScript runtime launches the system bubblewrap binary and does not link an embedded C helper.";
}
