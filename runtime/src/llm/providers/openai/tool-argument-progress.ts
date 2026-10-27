import { LLMStreamTruncatedError } from "../../errors.js";

/** Bound JSON padding without rejecting whitespace in file contents or strings. */
export class ToolArgumentProgress {
  #padding = 0;
  #inString = false;
  #escaped = false;

  push(delta: string, provider: string): void {
    for (const char of delta) {
      if (this.#inString) {
        if (this.#escaped) this.#escaped = false;
        else if (char === "\\") this.#escaped = true;
        else if (char === '"') this.#inString = false;
        this.#padding = 0;
      } else if (char === " " || char === "\n" || char === "\r" || char === "\t") {
        if (++this.#padding > 16_384) {
          // No call has been published. The turn can reconnect/resample safely.
          throw new LLMStreamTruncatedError(provider,
            "Tool argument stream stalled with excessive JSON whitespace before completion");
        }
      } else {
        this.#padding = 0;
        this.#inString = char === '"';
      }
    }
  }
}
