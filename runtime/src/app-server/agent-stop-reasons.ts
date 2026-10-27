/**
 * `agent.stop` reasons that carry a daemon-side meaning, shared by the daemon
 * and the TUI that sends them.
 *
 * @module
 */

/**
 * The TUI created this session while its user typed the first prompt, and the
 * session was never used: the TUI closed before a prompt, a staged startup
 * choice replaced it, or the daemon connection dropped under it. Besides
 * stopping the agent, the daemon archives the session's canonical thread when
 * that thread holds no input, so an untouched TUI leaves no session to list,
 * resume or continue.
 */
export const UNUSED_TUI_PREWARM_STOP_REASON = "tui_prewarm_unused";
