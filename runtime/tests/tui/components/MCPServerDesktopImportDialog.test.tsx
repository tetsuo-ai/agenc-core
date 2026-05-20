import { PassThrough } from "node:stream";
import React from "react";
import stripAnsi from "strip-ansi";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { McpServerConfig, ScopedMcpServerConfig } from "../../services/mcp/types.js";
import { createRoot } from "../ink/root.js";

const configMock = vi.hoisted(() => {
  const state = {
    existingServers: {} as Record<string, ScopedMcpServerConfig>,
  };

  return {
    state,
    addMcpConfig: vi.fn(async () => {}),
    getAllMcpConfigs: vi.fn(async () => ({ servers: state.existingServers })),
  };
});

const dialogMock = vi.hoisted(() => ({
  props: undefined as
    | undefined
    | {
      title: React.ReactNode;
      subtitle?: React.ReactNode;
      color?: string;
      onCancel: () => void;
      hideInputGuide?: boolean;
      children: React.ReactNode;
    },
}));

const selectMultiMock = vi.hoisted(() => ({
  props: undefined as
    | undefined
    | {
      options: { label: string; value: string }[];
      defaultValue?: string[];
      onSubmit?: (values: string[]) => void | Promise<void>;
      onCancel: () => void;
      hideIndexes?: boolean;
    },
  renderCount: 0,
}));

const processMock = vi.hoisted(() => ({
  writeToStdout: vi.fn(),
}));

const shutdownMock = vi.hoisted(() => ({
  gracefulShutdown: vi.fn(),
}));

vi.mock("../../services/mcp/config.js", () => ({
  addMcpConfig: configMock.addMcpConfig,
  getAllMcpConfigs: configMock.getAllMcpConfigs,
}));

vi.mock("../../utils/gracefulShutdown.js", () => ({
  gracefulShutdown: shutdownMock.gracefulShutdown,
}));

vi.mock("src/utils/process.js", () => ({
  writeToStdout: processMock.writeToStdout,
}));

vi.mock("../ink.js", async () => {
  const actual = await vi.importActual<typeof import("../ink.js")>("../ink.js");
  return {
    ...actual,
    color: () => (text: string) => text,
    useTheme: () => [{}],
  };
});

vi.mock("./CustomSelect/SelectMulti.js", () => ({
  SelectMulti: (props: NonNullable<typeof selectMultiMock.props>) => {
    selectMultiMock.props = props;
    selectMultiMock.renderCount++;
    return null;
  },
}));

vi.mock("./design-system/Dialog.js", () => ({
  Dialog: (props: NonNullable<typeof dialogMock.props>) => {
    dialogMock.props = props;
    return props.children;
  },
}));

vi.mock("./ConfigurableShortcutHint.js", () => ({
  ConfigurableShortcutHint: ({
    fallback,
    description,
  }: {
    fallback: string;
    description: string;
  }) => `${fallback} ${description}`,
}));

vi.mock("./design-system/Byline.js", () => ({
  Byline: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("./design-system/KeyboardShortcutHint.js", () => ({
  KeyboardShortcutHint: ({
    shortcut,
    action,
  }: {
    shortcut: string;
    action: string;
  }) => `${shortcut} ${action}`,
}));

function stdio() {
  let output = "";
  const stdout = new PassThrough();
  stdout.on("data", chunk => {
    output += chunk.toString();
  });
  (stdout as unknown as { columns: number }).columns = 120;

  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode: (mode: boolean) => void;
    ref: () => void;
    unref: () => void;
  };
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};

  return {
    stdout,
    stdin,
    output: () => stripAnsi(output),
    end: () => {
      stdin.end();
      stdout.end();
    },
  };
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  throw new Error("condition was not met");
}

const alphaServer = {
  type: "stdio",
  command: "alpha-mcp",
  args: ["--stdio"],
} satisfies McpServerConfig;

const betaServer = {
  type: "http",
  url: "https://example.test/mcp",
} satisfies McpServerConfig;

async function renderImportDialog({
  servers,
  scope = "project",
  onDone = vi.fn(),
}: {
  servers: Record<string, McpServerConfig>;
  scope?: "local" | "user" | "project";
  onDone?: () => void;
}) {
  const { MCPServerDesktopImportDialog } = await import(
    "./MCPServerDesktopImportDialog.js"
  );
  const io = stdio();
  const root = await createRoot({
    stdout: io.stdout as unknown as NodeJS.WriteStream,
    stdin: io.stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  });

  root.render(
    <MCPServerDesktopImportDialog
      servers={servers}
      scope={scope}
      onDone={onDone}
    />,
  );
  await waitFor(() => configMock.getAllMcpConfigs.mock.calls.length > 0);
  await waitFor(() => selectMultiMock.props !== undefined);

  return {
    io,
    onDone,
    rerender: () => {
      root.render(
        <MCPServerDesktopImportDialog
          servers={servers}
          scope={scope}
          onDone={onDone}
        />,
      );
    },
    unmount: () => {
      root.unmount();
      io.end();
    },
  };
}

describe("MCPServerDesktopImportDialog", () => {
  beforeEach(() => {
    configMock.state.existingServers = {};
    configMock.addMcpConfig.mockClear();
    configMock.getAllMcpConfigs.mockClear();
    dialogMock.props = undefined;
    selectMultiMock.props = undefined;
    selectMultiMock.renderCount = 0;
    processMock.writeToStdout.mockClear();
    shutdownMock.gracefulShutdown.mockClear();
  });

  it("loads existing servers and preselects only non-colliding imports", async () => {
    configMock.state.existingServers = {
      alpha: { ...alphaServer, scope: "user" },
      alpha_1: { ...alphaServer, scope: "local" },
    };
    const servers = { alpha: alphaServer, beta: betaServer };
    const rendered = await renderImportDialog({ servers });

    try {
      rendered.rerender();
      await waitFor(() => selectMultiMock.renderCount > 1);

      expect(dialogMock.props).toMatchObject({
        title: "Import MCP Servers from AgenC Desktop",
        subtitle: "Found 2 MCP servers in AgenC Desktop.",
        color: "success",
        hideInputGuide: true,
      });
      expect(selectMultiMock.props).toMatchObject({
        hideIndexes: true,
        defaultValue: ["beta"],
        options: [
          { label: "alpha (already exists)", value: "alpha" },
          { label: "beta", value: "beta" },
        ],
      });
      expect(rendered.io.output()).toContain(
        "Note: Some servers already exist with the same name.",
      );
      expect(rendered.io.output()).toContain(
        "Please select the servers you want to import:",
      );
    } finally {
      rendered.unmount();
    }
  });

  it("imports selected servers with numbered suffixes for name collisions", async () => {
    configMock.state.existingServers = {
      alpha: { ...alphaServer, scope: "user" },
      alpha_1: { ...alphaServer, scope: "local" },
    };
    const onDone = vi.fn();
    const servers = { alpha: alphaServer, beta: betaServer };
    const rendered = await renderImportDialog({ onDone, servers });

    try {
      await waitFor(() =>
        selectMultiMock.props?.defaultValue?.length === 1 &&
        selectMultiMock.props.defaultValue[0] === "beta",
      );
      await selectMultiMock.props?.onSubmit?.(["alpha", "beta", "missing"]);

      expect(configMock.addMcpConfig).toHaveBeenCalledTimes(2);
      expect(configMock.addMcpConfig).toHaveBeenNthCalledWith(
        1,
        "alpha_2",
        alphaServer,
        "project",
      );
      expect(configMock.addMcpConfig).toHaveBeenNthCalledWith(
        2,
        "beta",
        betaServer,
        "project",
      );
      expect(processMock.writeToStdout).toHaveBeenCalledWith(
        "\nSuccessfully imported 2 MCP servers to project config.\n",
      );
      expect(onDone).toHaveBeenCalledOnce();
      expect(shutdownMock.gracefulShutdown).toHaveBeenCalledOnce();
    } finally {
      rendered.unmount();
    }
  });

  it("reports singular success when exactly one server is imported", async () => {
    const rendered = await renderImportDialog({
      scope: "user",
      servers: { alpha: alphaServer },
    });

    try {
      await selectMultiMock.props?.onSubmit?.(["alpha"]);

      expect(configMock.addMcpConfig).toHaveBeenCalledWith(
        "alpha",
        alphaServer,
        "user",
      );
      expect(processMock.writeToStdout).toHaveBeenCalledWith(
        "\nSuccessfully imported 1 MCP server to user config.\n",
      );
    } finally {
      rendered.unmount();
    }
  });

  it("cancels empty imports without writing config", async () => {
    const onDone = vi.fn();
    const rendered = await renderImportDialog({ onDone, servers: {} });

    try {
      expect(dialogMock.props?.subtitle).toBe(
        "Found 0 MCP servers in AgenC Desktop.",
      );
      expect(selectMultiMock.props).toMatchObject({
        defaultValue: [],
        options: [],
      });

      dialogMock.props?.onCancel();

      expect(configMock.addMcpConfig).not.toHaveBeenCalled();
      expect(processMock.writeToStdout).toHaveBeenCalledWith(
        "\nNo servers were imported.",
      );
      expect(onDone).toHaveBeenCalledOnce();
      expect(shutdownMock.gracefulShutdown).toHaveBeenCalledOnce();
    } finally {
      rendered.unmount();
    }
  });

  it("select cancel follows the same no-import completion path", async () => {
    const rendered = await renderImportDialog({ servers: { alpha: alphaServer } });

    try {
      selectMultiMock.props?.onCancel();

      expect(configMock.addMcpConfig).not.toHaveBeenCalled();
      expect(processMock.writeToStdout).toHaveBeenCalledWith(
        "\nNo servers were imported.",
      );
      expect(shutdownMock.gracefulShutdown).toHaveBeenCalledOnce();
    } finally {
      rendered.unmount();
    }
  });
});
