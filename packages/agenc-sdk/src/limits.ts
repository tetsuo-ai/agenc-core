/**
 * Shared 16 MiB ceiling for the SDK's newline-delimited transports.
 *
 * The daemon socket, MCP stdio server, and both SDK transports use this
 * numeric ceiling. Measurement is intentionally versioned:
 *
 * - Subprocess (`promptViaSubprocess`): raw frame payload bytes, excluding
 *   the LF and a preceding CR. UTF-8 is decoded only after the payload is
 *   within this bound. Exactly {@link AGENC_SDK_MAX_FRAME_BYTES} is
 *   accepted; one extra byte fails whether or not a delimiter has arrived.
 * - Socket (`AgencSocketTransport`): UTF-8 byte length of the unsliced
 *   receive buffer before line split (existing decoder). A completed frame
 *   plus its delimiter can therefore trip the socket ceiling one byte
 *   earlier than the subprocess payload rule.
 */
export const AGENC_SDK_MAX_FRAME_BYTES = 16 * 1024 * 1024;
