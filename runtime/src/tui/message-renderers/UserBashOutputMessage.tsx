import * as React from 'react';
import BashToolResultMessage from '../../tools/BashTool/BashToolResultMessage.js';
import type { Out as BashOut } from '../../tools/BashTool/BashTool.js';
import { extractTag } from '../../utils/messages.js';
import { unescapeXml } from '../../utils/xml.js';

type Props = {
  content: string;
  verbose?: boolean;
};

type BashResultContent = Omit<BashOut, 'interrupted'>;

function extractStdout(content: string): string {
  const rawStdout = extractTag(content, 'bash-stdout') ?? '';
  return unescapeXml(extractTag(rawStdout, 'persisted-output') ?? rawStdout);
}

export function UserBashOutputMessage({
  content,
  verbose,
}: Props): React.ReactElement {
  const bashContent: BashResultContent = {
    stdout: extractStdout(content),
    stderr: unescapeXml(extractTag(content, 'bash-stderr') ?? ''),
  };

  return <BashToolResultMessage content={bashContent} verbose={Boolean(verbose)} />;
}
