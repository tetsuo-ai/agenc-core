import { PassThrough } from 'node:stream';

import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const selectProps = vi.hoisted(() => ({
  current: undefined as
    | undefined
    | {
        options: Array<{ label: React.ReactNode; value: string }>;
        onChange: (value: string) => void;
        onCancel: () => void;
      },
}));

vi.mock('../CustomSelect/select', () => ({
  Select: (props: {
    options: Array<{ label: React.ReactNode; value: string }>;
    onChange: (value: string) => void;
    onCancel: () => void;
  }) => {
    selectProps.current = props;
    return null;
  },
}));

vi.mock('../CustomSelect/select.js', () => ({
  Select: (props: {
    options: Array<{ label: React.ReactNode; value: string }>;
    onChange: (value: string) => void;
    onCancel: () => void;
  }) => {
    selectProps.current = props;
    return null;
  },
}));

vi.mock('./PermissionDialog', async () => {
  const ReactActual = await vi.importActual<typeof import('react')>('react');
  return {
    PermissionDialog: ({ children }: { children: React.ReactNode }) =>
      ReactActual.createElement(ReactActual.Fragment, null, children),
  };
});

vi.mock('./PermissionDialog.js', async () => {
  const ReactActual = await vi.importActual<typeof import('react')>('react');
  return {
    PermissionDialog: ({ children }: { children: React.ReactNode }) =>
      ReactActual.createElement(ReactActual.Fragment, null, children),
  };
});

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

function collectText(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') {
    return '';
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(collectText).join('');
  }
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) {
    return collectText(node.props.children);
  }
  return '';
}

describe('SandboxPermissionRequest', () => {
  beforeEach(() => {
    selectProps.current = undefined;
  });

  it('does not advertise reject feedback when the dialog cannot collect it', async () => {
    const { createRoot } = await import('../../ink.js');
    const { SandboxPermissionRequest } = await import('./SandboxPermissionRequest.js');
    const { stdout, stdin } = createTestStreams();
    const root = await createRoot({
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    });

    try {
      root.render(
        <SandboxPermissionRequest
          hostPattern={{ host: 'example.com' } as never}
          onUserResponse={() => {}}
        />,
      );
      await sleep(25);

      const denyOption = selectProps.current?.options.find(
        option => option.value === 'no',
      );

      expect(collectText(denyOption?.label)).toBe('No, deny connection');
      expect(collectText(denyOption?.label)).not.toContain('tell AgenC');
      expect(collectText(denyOption?.label)).not.toContain('(esc)');
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });
});
