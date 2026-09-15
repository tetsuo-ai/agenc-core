import { StringDecoder } from "node:string_decoder";
import { expect, it } from "vitest";
import { RecoverableUtf8Decoder } from "../../src/unified-exec/recoverable-utf8-decoder.js";

it("restores every two-byte prefix with Node's valid and invalid UTF-8 semantics", () => {
  const continuation = Buffer.from([0x80, 0xbf, 0xa0, 0x20, 0xf0, 0x90, 0x80, 0x80]);
  for (let prefix = 0; prefix < 65536; prefix++) {
    const node = new StringDecoder("utf8");
    let recovering = new RecoverableUtf8Decoder();
    for (const part of [Buffer.from([prefix >> 8]), Buffer.from([prefix & 255]), Buffer.alloc(0), continuation]) {
      const expected = node.write(part);
      const actual = recovering.write(part);
      if (actual !== expected) throw new Error(`Decoder diverged at prefix ${prefix}`);
      recovering = new RecoverableUtf8Decoder(recovering.snapshot());
    }
    if (recovering.end() !== node.end()) throw new Error(`Decoder EOF diverged at prefix ${prefix}`);
  }
});

it("preserves four-byte characters and malformed tails across every checkpoint and packet boundary", () => {
  const bytes = Buffer.concat([Buffer.from("ASCII α€𐀀😃"), Buffer.from([0xed, 0xa0, 0x80, 0xff, 0xf0, 0x90, 0x80])]);
  for (let boundary = 0; boundary <= bytes.length; boundary++) {
    for (let chunk = 1; chunk <= 7; chunk++) {
      let decoder = new RecoverableUtf8Decoder();
      let result = decoder.write(bytes.subarray(0, boundary));
      decoder = new RecoverableUtf8Decoder(decoder.snapshot());
      for (let offset = boundary; offset < bytes.length; offset += chunk) result += decoder.write(bytes.subarray(offset, offset + chunk));
      result += decoder.end();
      expect(result).toBe(bytes.toString("utf8"));
    }
  }
});

it.each(["YQ==", "gA==", "4oKs", "8JCAgA==", "4g", "4g==\n", "!!!!", "4h=="])("rejects invalid carry %s", (carry) => {
  expect(() => new RecoverableUtf8Decoder(carry)).toThrow("Invalid UTF-8 recovery carry");
});
