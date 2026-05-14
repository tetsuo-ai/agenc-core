import { BASH_TOOL_NAME } from '../../../../tools/BashTool/toolName.js';
import { extractOutputRedirections } from '../../../../utils/bash/commands.js'; // upstream-import: keep target is owned by another Z-PURGE item
import type { PermissionUpdate } from '../../../../utils/permissions/PermissionUpdateSchema.js'; // upstream-import: keep target is owned by another Z-PURGE item
import { shouldShowAlwaysAllowOptions } from '../../../../utils/permissions/permissionsLoader.js'; // upstream-import: keep target is owned by another Z-PURGE item
import type { OptionWithDescription } from '../../CustomSelect/select.js';
import { generateShellSuggestionsLabel } from '../shellPermissionHelpers.js';
export type BashToolUseOption = 'yes' | 'yes-apply-suggestions' | 'yes-prefix-edited' | 'no';

/**
 * Strip output redirections so filenames don't show as commands in the label.
 */
function stripBashRedirections(command: string): string {
  const {
    commandWithoutRedirections,
    redirections
  } = extractOutputRedirections(command);
  // Only use stripped version if there were actual redirections
  return redirections.length > 0 ? commandWithoutRedirections : command;
}
export function bashToolUseOptions({
  suggestions = [],
  onRejectFeedbackChange,
  onAcceptFeedbackChange,
  yesInputMode = false,
  noInputMode = false,
  editablePrefix,
  onEditablePrefixChange
}: {
  suggestions?: PermissionUpdate[];
  onRejectFeedbackChange: (value: string) => void;
  onAcceptFeedbackChange: (value: string) => void;
  yesInputMode?: boolean;
  noInputMode?: boolean;
  /** Editable prefix rule content (e.g., "npm run:*"). When set, replaces Haiku-based suggestions. */
  editablePrefix?: string;
  /** Callback when the user edits the prefix value. */
  onEditablePrefixChange?: (value: string) => void;
}): OptionWithDescription<BashToolUseOption>[] {
  const options: OptionWithDescription<BashToolUseOption>[] = [];
  if (yesInputMode) {
    options.push({
      type: 'input',
      label: 'Yes',
      value: 'yes',
      placeholder: 'and tell AgenC what to do next',
      onChange: onAcceptFeedbackChange,
      allowEmptySubmitToCancel: true
    });
  } else {
    options.push({
      label: 'Yes',
      value: 'yes'
    });
  }

  // Only show "always allow" options when not restricted by allowManagedPermissionRulesOnly
  if (shouldShowAlwaysAllowOptions()) {
    // Show an editable input for the prefix rule instead of the
    // Haiku-generated suggestion label — but only when the suggestions
    // don't contain non-Bash items (addDirectories, Read rules) that
    // the editable prefix can't represent.
    const hasNonBashSuggestions = suggestions.some(s => s.type === 'addDirectories' || s.type === 'addRules' && s.rules?.some(r => r.toolName !== BASH_TOOL_NAME));
    if (editablePrefix !== undefined && onEditablePrefixChange && !hasNonBashSuggestions && suggestions.length > 0) {
      options.push({
        type: 'input',
        label: 'Yes, and don\u2019t ask again for',
        value: 'yes-prefix-edited',
        placeholder: 'command prefix (e.g., npm run:*)',
        initialValue: editablePrefix,
        onChange: onEditablePrefixChange,
        allowEmptySubmitToCancel: true,
        showLabelWithValue: true,
        labelValueSeparator: ': ',
        resetCursorOnUpdate: true
      });
    } else if (suggestions.length > 0) {
      const label = generateShellSuggestionsLabel(suggestions, BASH_TOOL_NAME, stripBashRedirections);
      if (label) {
        options.push({
          label,
          value: 'yes-apply-suggestions'
        });
      }
    }
  }
  if (noInputMode) {
    options.push({
      type: 'input',
      label: 'No',
      value: 'no',
      placeholder: 'and tell AgenC what to do differently',
      onChange: onRejectFeedbackChange,
      allowEmptySubmitToCancel: true
    });
  } else {
    options.push({
      label: 'No',
      value: 'no'
    });
  }
  return options;
}
