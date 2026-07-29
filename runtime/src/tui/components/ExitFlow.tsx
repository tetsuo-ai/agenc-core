// Moved-source note: imported by moved purge roots until the owning subsystem is absorbed.
import { c as _c } from "react-compiler-runtime";
import sample from 'lodash-es/sample.js';
import React from 'react';
import { gracefulShutdown } from '../../utils/gracefulShutdown.js'; // upstream-import: keep target is owned by another Z-PURGE item
import { WorktreeExitDialog } from './WorktreeExitDialog';
const GOODBYE_MESSAGES = ['Goodbye!', 'See ya!', 'Bye!', 'Catch you later!'];
function getRandomGoodbyeMessage(): string {
  return sample(GOODBYE_MESSAGES) ?? 'Goodbye!';
}
type Props = {
  onDone: (message?: string) =>
    void | boolean | Promise<void | boolean>;
  onCancel?: () => void;
  beforeWorktreeMutation?: () => boolean | Promise<boolean>;
  showWorktree: boolean;
};
export function ExitFlow(t0) {
  const $ = _c(6);
  const {
    showWorktree,
    onDone,
    onCancel,
    beforeWorktreeMutation
  } = t0;
  let t1;
  if ($[0] !== onDone) {
    t1 = async function onExit(resultMessage) {
      const shouldExit = await onDone(resultMessage ?? getRandomGoodbyeMessage());
      if (shouldExit === false) return;
      await gracefulShutdown(0, "prompt_input_exit");
    };
    $[0] = onDone;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  const onExit = t1;
  if (showWorktree) {
    let t2;
    if (
      $[2] !== beforeWorktreeMutation ||
      $[3] !== onCancel ||
      $[4] !== onExit
    ) {
      t2 = <WorktreeExitDialog
        onDone={onExit}
        onCancel={onCancel}
        beforeMutation={beforeWorktreeMutation}
      />;
      $[2] = beforeWorktreeMutation;
      $[3] = onCancel;
      $[4] = onExit;
      $[5] = t2;
    } else {
      t2 = $[5];
    }
    return t2;
  }
  return null;
}
