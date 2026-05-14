import { PassThrough } from 'node:stream';

import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const keybinding = vi.hoisted(() => ({
  handler: undefined as undefined | (() => void),
}));

const explainer = vi.hoisted(() => ({
  signals: [] as AbortSignal[],
  generate: vi.fn((args: { signal: AbortSignal }) => {
    explainer.signals.push(args.signal);
    return new Promise(() => {});
  }),
}));

vi.mock('../../keybindings/useKeybinding.js', () => ({
  useKeybinding: (_action: string, handler: () => void) => {
    keybinding.handler = handler;
  },
}));

vi.mock('../../../services/analytics/index.js', () => ({
  logEvent: vi.fn(),
}));

vi.mock('../../../utils/permissions/permissionExplainer.js', () => ({
  generatePermissionExplanation: explainer.generate,
  isPermissionExplainerEnabled: () => true,
}));

function createTestStreams(): {
  stdout: PassThrough;
  stdin: PassThrough & {
    isTTY: boolean;
    setRawMode: (mode: boolean) => void;
    ref: () => void;
    unref: () => void;
  };
} {
  const stdout = new PassThrough();
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
  ;(stdout as unknown as { columns: number }).columns = 120;

  return { stdout, stdin };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('usePermissionExplainerUI abort ownership', () => {
  beforeEach(() => {
    keybinding.handler = undefined;
    explainer.signals = [];
    explainer.generate.mockClear();
  });

  it('aborts an in-flight explanation when the owner unmounts', async () => {
    const { createRoot } = await import('../../ink.js');
    const { usePermissionExplainerUI } = await import('./PermissionExplanation.js');
    const { stdout, stdin } = createTestStreams();
    const root = await createRoot({
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    });

    function Harness(): null {
      usePermissionExplainerUI({
        toolName: 'Bash',
        toolInput: { command: 'pwd' },
      });
      return null;
    }

    try {
      root.render(<Harness />);
      await sleep(25);

      keybinding.handler?.();

      expect(explainer.generate).toHaveBeenCalledTimes(1);
      expect(explainer.signals[0]?.aborted).toBe(false);

      root.unmount();

      expect(explainer.signals[0]?.aborted).toBe(true);
    } finally {
      stdin.end();
      stdout.end();
    }
  });

  it('aborts an in-flight explanation when the permission context aborts', async () => {
    const { createRoot } = await import('../../ink.js');
    const { usePermissionExplainerUI } = await import('./PermissionExplanation.js');
    const { stdout, stdin } = createTestStreams();
    const parentAbortController = new AbortController();
    const root = await createRoot({
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    });

    function Harness(): null {
      usePermissionExplainerUI({
        toolName: 'Bash',
        toolInput: { command: 'pwd' },
        abortSignal: parentAbortController.signal,
      });
      return null;
    }

    try {
      root.render(<Harness />);
      await sleep(25);

      keybinding.handler?.();

      expect(explainer.generate).toHaveBeenCalledTimes(1);
      expect(explainer.signals[0]?.aborted).toBe(false);

      parentAbortController.abort('permission closed');

      expect(explainer.signals[0]?.aborted).toBe(true);
      expect(explainer.signals[0]?.reason).toBe('permission closed');
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });
});
