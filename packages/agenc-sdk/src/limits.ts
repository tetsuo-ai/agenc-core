/**
 * Shared 16 MiB ceiling for the SDK's newline-delimited transports.
 *
 * The daemon socket, MCP stdio server, and both SDK transports use this
 * numeric ceiling. Payload bytes exclude an LF, a CRLF, or a lone CR
 * delimiter. Exactly {@link AGENC_SDK_MAX_FRAME_BYTES} is accepted. One
 * extra payload byte fails whether or not a delimiter has arrived, and a
 * completed frame is measured on its own rather than on the read chunk
 * that delivered it.
 */
export const AGENC_SDK_MAX_FRAME_BYTES = 16 * 1024 * 1024;
