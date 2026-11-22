/** A remote connection's grant: read only, or able to drive its sessions. */
export type RemoteRole = "view" | "control";
export class RemoteError extends Error {
  constructor(readonly code: string, message = code) { super(message); this.name = "RemoteError"; }
}
