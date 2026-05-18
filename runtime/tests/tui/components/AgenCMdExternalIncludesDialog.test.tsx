import React from 'react';
import { describe, expect, test, vi } from 'vitest';

import type { ProjectConfig } from '../../utils/config.js';

vi.mock('../../services/analytics/index.js', () => ({ logEvent: vi.fn() }));
vi.mock('../../utils/config.js', () => ({ saveCurrentProjectConfig: vi.fn() }));
vi.mock('../ink.js', () => ({
  Box: () => null,
  Link: () => null,
  Text: () => null,
}));
vi.mock('./CustomSelect/select', () => ({ Select: () => null }));
vi.mock('./design-system/Dialog', () => ({ Dialog: () => null }));

import {
  applyAgenCMdExternalIncludeDecision,
  AgenCMdExternalIncludesDialogView,
  type ExternalIncludeDecision,
} from './AgenCMdExternalIncludesDialog.js';

function collectText(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(collectText).join('');
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) {
    return collectText(node.props.children);
  }
  return '';
}

function findElement(
  node: React.ReactNode,
  predicate: (element: React.ReactElement) => boolean,
): React.ReactElement | null {
  if (node === null || node === undefined || typeof node === 'boolean') {
    return null;
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, predicate);
      if (found) return found;
    }
    return null;
  }
  if (!React.isValidElement(node)) return null;
  if (predicate(node)) return node;
  return findElement(node.props.children, predicate);
}

function applyDecision(value: ExternalIncludeDecision): {
  config: ProjectConfig;
  events: string[];
} {
  let config: ProjectConfig = {
    allowedTools: [],
    mcpContextUris: [],
    projectOnboardingSeenCount: 0,
    hasAgenCMdExternalIncludesApproved: undefined,
    hasAgenCMdExternalIncludesWarningShown: undefined,
  };
  const events: string[] = [];

  applyAgenCMdExternalIncludeDecision(value, {
    log: vi.fn((eventName: string) => {
      events.push(eventName);
    }),
    saveConfig: updater => {
      config = updater(config);
    },
  });

  return { config, events };
}

describe('AgenCMdExternalIncludesDialog decision handling', () => {
  test('accepting external includes records approval and warning state', () => {
    const { config, events } = applyDecision('yes');

    expect(config.hasAgenCMdExternalIncludesApproved).toBe(true);
    expect(config.hasAgenCMdExternalIncludesWarningShown).toBe(true);
    expect(events).toEqual([
      'tengu_agenc_md_external_includes_dialog_accepted',
    ]);
  });

  test('declining external includes records rejection and warning state', () => {
    const { config, events } = applyDecision('no');

    expect(config.hasAgenCMdExternalIncludesApproved).toBe(false);
    expect(config.hasAgenCMdExternalIncludesWarningShown).toBe(true);
    expect(events).toEqual([
      'tengu_agenc_md_external_includes_dialog_declined',
    ]);
  });

  test('view renders trust copy, include list, standalone props, and callbacks', () => {
    const selections: ExternalIncludeDecision[] = [];
    let cancelled = false;

    const dialog = AgenCMdExternalIncludesDialogView({
      isStandaloneDialog: true,
      externalIncludes: [
        { path: '/outside/policy.md', parent: '/repo/AGENC.md' },
      ],
      onSelect: value => selections.push(value),
      onCancel: () => {
        cancelled = true;
      },
    });

    expect(dialog.props.title).toBe('Allow external AGENC.md file imports?');
    expect(dialog.props.hideBorder).toBe(false);
    expect(dialog.props.hideInputGuide).toBe(false);
    expect(collectText(dialog.props.children)).toContain(
      "This project's AGENC.md imports files outside the current working directory.",
    );
    expect(collectText(dialog.props.children)).toContain('/outside/policy.md');

    dialog.props.onCancel();
    expect(cancelled).toBe(true);

    const select = findElement(
      dialog.props.children,
      element => Array.isArray(element.props.options),
    );
    expect(select?.props.options.map((option: { value: string }) => option.value)).toEqual([
      'yes',
      'no',
    ]);
    select?.props.onChange('yes');
    expect(selections).toEqual(['yes']);
  });
});
