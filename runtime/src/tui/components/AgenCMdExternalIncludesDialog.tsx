import React, { useEffect } from 'react';

import { logEvent } from '../../services/analytics/index.js';
import type { ExternalAgenCMdInclude } from '../../memory/index.js';
import { saveCurrentProjectConfig } from '../../utils/config.js';
import { Box, Link, Text } from '../ink.js';
import { Select } from './CustomSelect/select';
import { Dialog } from './design-system/Dialog';

type Props = {
  onDone(): void;
  isStandaloneDialog?: boolean;
  externalIncludes?: ExternalAgenCMdInclude[];
};

const EXTERNAL_INCLUDE_OPTIONS = [
  {
    label: 'Yes, allow external imports',
    value: 'yes',
  },
  {
    label: 'No, disable external imports',
    value: 'no',
  },
] as const;

export type ExternalIncludeDecision =
  (typeof EXTERNAL_INCLUDE_OPTIONS)[number]['value'];

type ApplyDecisionDeps = {
  log?: typeof logEvent;
  saveConfig?: typeof saveCurrentProjectConfig;
};

export function applyAgenCMdExternalIncludeDecision(
  value: ExternalIncludeDecision,
  deps: ApplyDecisionDeps = {},
): void {
  const log = deps.log ?? logEvent;
  const saveConfig = deps.saveConfig ?? saveCurrentProjectConfig;

  if (value === 'no') {
    log('tengu_agenc_md_external_includes_dialog_declined', {});
    saveConfig(current => ({
      ...current,
      hasAgenCMdExternalIncludesApproved: false,
      hasAgenCMdExternalIncludesWarningShown: true,
    }));
    return;
  }

  log('tengu_agenc_md_external_includes_dialog_accepted', {});
  saveConfig(current => ({
    ...current,
    hasAgenCMdExternalIncludesApproved: true,
    hasAgenCMdExternalIncludesWarningShown: true,
  }));
}

export type AgenCMdExternalIncludesDialogViewProps = {
  isStandaloneDialog?: boolean;
  externalIncludes?: ExternalAgenCMdInclude[];
  onSelect(value: ExternalIncludeDecision): void;
  onCancel(): void;
};

export function AgenCMdExternalIncludesDialogView({
  isStandaloneDialog,
  externalIncludes,
  onSelect,
  onCancel,
}: AgenCMdExternalIncludesDialogViewProps) {
  return (
    <Dialog
      title="Allow external AGENC.md file imports?"
      color="warning"
      onCancel={onCancel}
      hideBorder={!isStandaloneDialog}
      hideInputGuide={!isStandaloneDialog}
    >
      <Text>
        This project's AGENC.md imports files outside the current working
        directory. Never allow this for third-party repositories.
      </Text>
      {externalIncludes && externalIncludes.length > 0 ? (
        <Box flexDirection="column">
          <Text dimColor>External imports:</Text>
          {externalIncludes.map((include, index) => (
            <Text key={`${include.parent}:${include.path}:${index}`} dimColor>
              {'  '}
              {include.path}
            </Text>
          ))}
        </Box>
      ) : null}
      <Text dimColor>
        Important: Only use AgenC with files you trust. Accessing untrusted
        files may pose security risks{' '}
        <Link url="https://agenc.tech/docs/en/security" />{' '}
      </Text>
      <Select
        options={[...EXTERNAL_INCLUDE_OPTIONS]}
        onChange={(value: string) => onSelect(value as ExternalIncludeDecision)}
      />
    </Dialog>
  );
}

export function AgenCMdExternalIncludesDialog({
  onDone,
  isStandaloneDialog,
  externalIncludes,
}: Props) {
  useEffect(() => {
    logEvent('tengu_agenc_md_includes_dialog_shown', {});
  }, []);

  const handleSelection = (value: ExternalIncludeDecision) => {
    applyAgenCMdExternalIncludeDecision(value);
    onDone();
  };

  const handleEscape = () => {
    handleSelection('no');
  };

  return (
    <AgenCMdExternalIncludesDialogView
      isStandaloneDialog={isStandaloneDialog}
      externalIncludes={externalIncludes}
      onSelect={handleSelection}
      onCancel={handleEscape}
    />
  );
}
