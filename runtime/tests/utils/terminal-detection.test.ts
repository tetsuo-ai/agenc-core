import { describe, expect, it } from "vitest";

import {
  TerminalName,
  detectTerminalInfoFromEnv,
  isZellijTerminal,
  terminalNameFromTermProgram,
  terminalUserAgentToken,
  type Multiplexer,
  type TerminalDetectionEnvironment,
  type TerminalInfo,
  type TmuxClientInfo,
} from "./terminal-detection.js";

class FakeEnvironment implements TerminalDetectionEnvironment {
  private readonly vars = new Map<string, string>();
  private clientInfo: TmuxClientInfo = {};

  withVar(key: string, value: string): this {
    this.vars.set(key, value);
    return this;
  }

  withTmuxClientInfo(termtype?: string, termname?: string): this {
    this.clientInfo = {
      ...(termtype !== undefined ? { termtype } : {}),
      ...(termname !== undefined ? { termname } : {}),
    };
    return this;
  }

  get(name: string): string | undefined {
    return this.vars.get(name);
  }

  tmuxClientInfo(): TmuxClientInfo {
    return this.clientInfo;
  }
}

function terminalInfo(
  name: TerminalInfo["name"],
  options: {
    readonly termProgram?: string;
    readonly version?: string;
    readonly term?: string;
    readonly multiplexer?: Multiplexer;
  } = {},
): TerminalInfo {
  return {
    name,
    ...(options.termProgram !== undefined
      ? { termProgram: options.termProgram }
      : {}),
    ...(options.version !== undefined ? { version: options.version } : {}),
    ...(options.term !== undefined ? { term: options.term } : {}),
    ...(options.multiplexer !== undefined
      ? { multiplexer: options.multiplexer }
      : {}),
  };
}

describe("terminal program detection", () => {
  it("prefers TERM_PROGRAM and preserves version metadata", () => {
    const terminal = detectTerminalInfoFromEnv(
      new FakeEnvironment()
        .withVar("TERM_PROGRAM", "iTerm.app")
        .withVar("TERM_PROGRAM_VERSION", "3.5.0")
        .withVar("WEZTERM_VERSION", "2024.2"),
    );

    expect(terminal).toEqual(
      terminalInfo(TerminalName.Iterm2, {
        termProgram: "iTerm.app",
        version: "3.5.0",
      }),
    );
    expect(terminalUserAgentToken(terminal)).toBe("iTerm.app/3.5.0");
  });

  it("drops empty version strings", () => {
    const terminal = detectTerminalInfoFromEnv(
      new FakeEnvironment()
        .withVar("TERM_PROGRAM", "iTerm.app")
        .withVar("TERM_PROGRAM_VERSION", ""),
    );

    expect(terminal).toEqual(
      terminalInfo(TerminalName.Iterm2, { termProgram: "iTerm.app" }),
    );
    expect(terminalUserAgentToken(terminal)).toBe("iTerm.app");
  });

  it("normalizes terminal program spellings", () => {
    expect(terminalNameFromTermProgram("Apple_Terminal")).toBe(
      TerminalName.AppleTerminal,
    );
    expect(terminalNameFromTermProgram("iTerm.app")).toBe(TerminalName.Iterm2);
    expect(terminalNameFromTermProgram("Warp-Terminal")).toBe(
      TerminalName.WarpTerminal,
    );
    expect(terminalNameFromTermProgram("gnome terminal")).toBe(
      TerminalName.GnomeTerminal,
    );
    expect(terminalNameFromTermProgram("unknown")).toBeUndefined();
  });
});

describe("known terminal probes", () => {
  it("detects Apple Terminal", () => {
    expect(
      detectTerminalInfoFromEnv(
        new FakeEnvironment().withVar("TERM_PROGRAM", "Apple_Terminal"),
      ),
    ).toEqual(
      terminalInfo(TerminalName.AppleTerminal, {
        termProgram: "Apple_Terminal",
      }),
    );

    const terminal = detectTerminalInfoFromEnv(
      new FakeEnvironment().withVar("TERM_SESSION_ID", "A1B2C3"),
    );
    expect(terminal).toEqual(terminalInfo(TerminalName.AppleTerminal));
    expect(terminalUserAgentToken(terminal)).toBe("Apple_Terminal");
  });

  it("detects Ghostty, VS Code, and Warp from TERM_PROGRAM", () => {
    expect(
      terminalUserAgentToken(
        detectTerminalInfoFromEnv(
          new FakeEnvironment().withVar("TERM_PROGRAM", "Ghostty"),
        ),
      ),
    ).toBe("Ghostty");

    expect(
      terminalUserAgentToken(
        detectTerminalInfoFromEnv(
          new FakeEnvironment()
            .withVar("TERM_PROGRAM", "vscode")
            .withVar("TERM_PROGRAM_VERSION", "1.86.0"),
        ),
      ),
    ).toBe("vscode/1.86.0");

    expect(
      terminalUserAgentToken(
        detectTerminalInfoFromEnv(
          new FakeEnvironment()
            .withVar("TERM_PROGRAM", "WarpTerminal")
            .withVar("TERM_PROGRAM_VERSION", "v0.2025.12.10"),
        ),
      ),
    ).toBe("WarpTerminal/v0.2025.12.10");
  });

  it("detects WezTerm from version, program, and TERM fallbacks", () => {
    expect(
      detectTerminalInfoFromEnv(
        new FakeEnvironment().withVar("WEZTERM_VERSION", "2024.2"),
      ),
    ).toEqual(
      terminalInfo(TerminalName.WezTerm, { version: "2024.2" }),
    );

    expect(
      terminalUserAgentToken(
        detectTerminalInfoFromEnv(
          new FakeEnvironment()
            .withVar("TERM_PROGRAM", "WezTerm")
            .withVar("TERM_PROGRAM_VERSION", "2024.2"),
        ),
      ),
    ).toBe("WezTerm/2024.2");

    expect(
      detectTerminalInfoFromEnv(
        new FakeEnvironment().withVar("TERM", "wezterm-mux"),
      ),
    ).toEqual(
      terminalInfo(TerminalName.WezTerm, { term: "wezterm-mux" }),
    );
  });

  it("detects kitty and gives kitty precedence over alacritty", () => {
    expect(
      detectTerminalInfoFromEnv(
        new FakeEnvironment().withVar("KITTY_WINDOW_ID", "1"),
      ),
    ).toEqual(terminalInfo(TerminalName.Kitty));

    expect(
      detectTerminalInfoFromEnv(
        new FakeEnvironment()
          .withVar("TERM", "xterm-kitty")
          .withVar("ALACRITTY_SOCKET", "/tmp/alacritty"),
      ),
    ).toEqual(terminalInfo(TerminalName.Kitty));
  });

  it("detects alacritty, konsole, GNOME Terminal, VTE, and Windows Terminal", () => {
    expect(
      detectTerminalInfoFromEnv(
        new FakeEnvironment().withVar("ALACRITTY_SOCKET", "/tmp/alacritty"),
      ),
    ).toEqual(terminalInfo(TerminalName.Alacritty));

    expect(
      terminalUserAgentToken(
        detectTerminalInfoFromEnv(
          new FakeEnvironment().withVar("KONSOLE_VERSION", "230800"),
        ),
      ),
    ).toBe("Konsole/230800");

    expect(
      terminalUserAgentToken(
        detectTerminalInfoFromEnv(
          new FakeEnvironment().withVar("GNOME_TERMINAL_SCREEN", "1"),
        ),
      ),
    ).toBe("gnome-terminal");

    expect(
      terminalUserAgentToken(
        detectTerminalInfoFromEnv(
          new FakeEnvironment().withVar("VTE_VERSION", "7000"),
        ),
      ),
    ).toBe("VTE/7000");

    expect(
      terminalUserAgentToken(
        detectTerminalInfoFromEnv(
          new FakeEnvironment().withVar("WT_SESSION", "1"),
        ),
      ),
    ).toBe("WindowsTerminal");
  });
});

describe("multiplexer detection", () => {
  it("detects tmux and uses tmux client termtype when TERM_PROGRAM is tmux", () => {
    const terminal = detectTerminalInfoFromEnv(
      new FakeEnvironment()
        .withVar("TMUX", "/tmp/tmux-1000/default,123,0")
        .withVar("TERM_PROGRAM", "tmux")
        .withVar("TERM_PROGRAM_VERSION", "3.6a")
        .withTmuxClientInfo("ghostty 1.2.3", "xterm-ghostty"),
    );

    expect(terminal).toEqual(
      terminalInfo(TerminalName.Ghostty, {
        termProgram: "ghostty",
        version: "1.2.3",
        term: "xterm-ghostty",
        multiplexer: { type: "tmux", version: "3.6a" },
      }),
    );
    expect(terminalUserAgentToken(terminal)).toBe("ghostty/1.2.3");
  });

  it("falls back to tmux client termname when termtype is absent", () => {
    const terminal = detectTerminalInfoFromEnv(
      new FakeEnvironment()
        .withVar("TMUX", "/tmp/tmux-1000/default,123,0")
        .withVar("TERM_PROGRAM", "tmux")
        .withTmuxClientInfo(undefined, "xterm-256color"),
    );

    expect(terminal).toEqual(
      terminalInfo(TerminalName.Unknown, {
        term: "xterm-256color",
        multiplexer: { type: "tmux" },
      }),
    );
    expect(terminalUserAgentToken(terminal)).toBe("xterm-256color");
  });

  it("keeps tmux multiplexer metadata when TERM_PROGRAM is not tmux", () => {
    const terminal = detectTerminalInfoFromEnv(
      new FakeEnvironment()
        .withVar("TMUX_PANE", "%1")
        .withVar("TERM_PROGRAM", "WezTerm")
        .withVar("TERM_PROGRAM_VERSION", "2024.2"),
    );

    expect(terminal).toEqual(
      terminalInfo(TerminalName.WezTerm, {
        termProgram: "WezTerm",
        version: "2024.2",
        multiplexer: { type: "tmux" },
      }),
    );
  });

  it("detects zellij and exposes the zellij helper", () => {
    const terminal = detectTerminalInfoFromEnv(
      new FakeEnvironment().withVar("ZELLIJ", "1"),
    );

    expect(terminal).toEqual(
      terminalInfo(TerminalName.Unknown, {
        multiplexer: { type: "zellij" },
      }),
    );
    expect(isZellijTerminal(terminal)).toBe(true);
    expect(
      isZellijTerminal(
        terminalInfo(TerminalName.Unknown, { multiplexer: { type: "tmux" } }),
      ),
    ).toBe(false);
  });
});

describe("TERM fallback and user-agent sanitizing", () => {
  it("falls back to TERM, dumb, and unknown", () => {
    expect(
      terminalUserAgentToken(
        detectTerminalInfoFromEnv(
          new FakeEnvironment().withVar("TERM", "xterm-256color"),
        ),
      ),
    ).toBe("xterm-256color");

    expect(
      detectTerminalInfoFromEnv(new FakeEnvironment().withVar("TERM", "dumb")),
    ).toEqual(terminalInfo(TerminalName.Dumb, { term: "dumb" }));

    expect(detectTerminalInfoFromEnv(new FakeEnvironment())).toEqual(
      terminalInfo(TerminalName.Unknown),
    );
  });

  it("sanitizes values for header-safe user-agent tokens", () => {
    expect(
      terminalUserAgentToken(
        terminalInfo(TerminalName.Unknown, {
          termProgram: "Bad Terminal",
          version: "1.0\r\nbad",
        }),
      ),
    ).toBe("Bad_Terminal/1.0__bad");
  });
});
