/**
 * @tetsuo-ai/runtime — lean coding CLI
 *
 * Post-gut: this barrel only re-exports the minimum surface a host
 * needs. The agent loop, tools, and TUI are internal; consumers should
 * reach for the `agenc` binary, not the runtime module.
 *
 * @packageDocumentation
 */

export const VERSION = "0.2.0";
