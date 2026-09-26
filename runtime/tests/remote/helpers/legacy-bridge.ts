import { EventEmitter } from "node:events";

/** What the legacy bridge sees of a socket: the relay it dialed, or a loopback daemon socket per phone. */
export interface FakeSocket {
  readonly url: string;
  readyState: number;
  readonly sent: string[];
  _queue?: string[];
  emit(event: string, ...args: unknown[]): boolean;
  terminate(): void;
}

/** Every socket the bridge opened, in order: index 0 is the relay, later ones are daemon sockets. */
export const fakeSockets: FakeSocket[] = [];

/** Module factory for `vi.mock("ws", ...)`: records sockets instead of connecting anywhere. */
export function fakeWsModule(): { default: unknown } {
  class Socket extends EventEmitter {
    static readonly OPEN = 1;
    readyState = 0;
    sent: string[] = [];
    constructor(readonly url: string) { super(); fakeSockets.push(this as unknown as FakeSocket); }
    send(value: string) { this.sent.push(value); }
    close() { this.terminate(); }
    terminate() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.emit("close");
    }
  }
  return { default: Socket };
}

/** The backend's answer to `pair/start` and `pair/host-poll` in these fixtures. */
export function pairStartResponse(): Response {
  return new Response(JSON.stringify({ pairingId: "fixture-pair", hostSecret: "fixture-secret", relayUrl: "wss://relay.example", hostTicket: "fixture-ticket", code: "ABCDEFGH", expiresAt: new Date(Date.now() + 180_000).toISOString() }), { status: 200 });
}
