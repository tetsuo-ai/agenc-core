import { StringDecoder } from "node:string_decoder";

/** Node's decoding semantics with a portable, bounded recovery cursor. */
export class RecoverableUtf8Decoder {
  private readonly decoder = new StringDecoder("utf8");
  private pending = Buffer.alloc(0);

  constructor(carry = "") {
    if (typeof carry !== "string" || carry.length > 4) throw new Error("Invalid UTF-8 recovery carry");
    const bytes = Buffer.from(carry, "base64");
    if (bytes.length > 3 || bytes.toString("base64") !== carry ||
        this.decoder.write(bytes) !== "") {
      throw new Error("Invalid UTF-8 recovery carry");
    }
    this.pending = bytes;
  }

  write(bytes: Buffer): string {
    const text = this.decoder.write(bytes);
    // At most three bytes can remain undecoded. Probe with the public decoder
    // interface instead of persisting its undocumented internal fields. Include
    // previous carry when a short packet completes only part of a character.
    const tail = bytes.length >= 3 ? bytes.subarray(-3) : Buffer.concat([this.pending, bytes]).subarray(-3);
    this.pending = Buffer.alloc(0);
    for (let length = tail.length; length > 0; length--) {
      const candidate = tail.subarray(-length);
      if (new StringDecoder("utf8").write(candidate) === "") {
        this.pending = Buffer.from(candidate);
        break;
      }
    }
    return text;
  }

  snapshot(): string { return this.pending.toString("base64"); }

  end(): string {
    this.pending = Buffer.alloc(0);
    return this.decoder.end();
  }
}
