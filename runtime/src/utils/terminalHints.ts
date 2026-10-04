import chalk from 'chalk';
import { getShortcutDisplay } from '../tui/keybindings/shortcutFormat.js';

export function ctrlOToExpand(): string {
  const shortcut = getShortcutDisplay('app:toggleTranscript', 'Global', 'ctrl+o');
  return chalk.dim(`(${shortcut} to expand)`);
}
