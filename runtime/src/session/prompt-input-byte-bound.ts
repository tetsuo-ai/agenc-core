import { MAX_TOKEN_ACCOUNTING_REQUEST_BYTES, type TokenAccountingRequest } from "../llm/token-accounting.js";

/** An advisory upper bound, never a replacement for dispatch admission. */
export function promptInputTokenByteBound(request: TokenAccountingRequest): number | undefined {
  // These text adapters use byte-based token vocabularies. Native media/tools
  // and other provider projections need their usual accounting instead.
  if (request.provider !== "deepseek" && request.provider !== "openai") return undefined;
  if ((request.providerNativeTools?.length ?? 0) !== 0) return undefined;
  if (request.messages.some(message => typeof message.content !== "string" &&
    message.content.some(part => part.type !== "text"))) return undefined;
  try {
    // Count large text without serializing/copying it. The options still
    // include every schema and system/developer instruction. Metadata and
    // tool arguments are serialized separately from the content strings.
    let textBytes = 0;
    let envelopeBytes = Buffer.byteLength(JSON.stringify({ ...request, messages: undefined }), "utf8");
    for (const message of request.messages) {
      envelopeBytes += Buffer.byteLength(JSON.stringify({ ...message, content: undefined }), "utf8");
      if (typeof message.content === "string") textBytes += Buffer.byteLength(message.content, "utf8");
      else for (const part of message.content) {
        if (part.type !== "text") return undefined;
        textBytes += Buffer.byteLength(part.text, "utf8");
        envelopeBytes += Buffer.byteLength(JSON.stringify({ ...part, text: undefined }), "utf8");
      }
    }
    const framing = 1024 + 64 * (request.messages.length + (request.options.tools?.length ?? 0));
    const bound = envelopeBytes + textBytes + framing;
    // JSON can escape a one-byte control character as six bytes. Preserve
    // the separate request-byte cap even when the model sees unescaped text.
    const serializedByteBound = envelopeBytes + 6 * textBytes + framing;
    return Number.isSafeInteger(bound) && serializedByteBound < MAX_TOKEN_ACCOUNTING_REQUEST_BYTES ? bound : undefined;
  } catch {
    return undefined;
  }
}
