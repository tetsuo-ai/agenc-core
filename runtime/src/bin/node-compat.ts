import { File as NodeFile } from "node:buffer";

export function installNodeRuntimeCompat(): void {
  if (typeof globalThis.File === "undefined") {
    globalThis.File = NodeFile as typeof globalThis.File;
  }
}

installNodeRuntimeCompat();
