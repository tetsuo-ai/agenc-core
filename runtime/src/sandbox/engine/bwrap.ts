/** Linux/WSL compatibility detection used by the sandbox engine. */

import fs from "node:fs";

export function isWsl1(procVersion?: string): boolean {
  if (procVersion !== undefined) return procVersionIndicatesWsl1(procVersion);
  try {
    return procVersionIndicatesWsl1(fs.readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

export function procVersionIndicatesWsl1(procVersion: string): boolean {
  const lower = procVersion.toLowerCase();
  let remaining = lower;
  while (true) {
    const marker = remaining.indexOf("wsl");
    if (marker === -1) break;
    const rest = remaining.slice(marker + "wsl".length);
    const digits = rest.match(/^\d+/u)?.[0];
    if (digits !== undefined) return Number.parseInt(digits, 10) === 1;
    remaining = rest;
  }
  return lower.includes("microsoft") && !lower.includes("microsoft-standard");
}
