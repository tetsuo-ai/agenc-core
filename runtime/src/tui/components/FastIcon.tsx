// Moved-source note: imported by moved purge roots until the owning subsystem is absorbed.
import { c as _c } from "react-compiler-runtime";
import { LIGHTNING_BOLT } from '../../constants/figures.js'; // upstream-import: keep target is owned by another Z-PURGE item
import { Text } from '../ink.js';
type Props = {
  cooldown?: boolean;
};
export function FastIcon(t0: Props) {
  const $ = _c(2);
  const {
    cooldown
  } = t0;
  if (cooldown) {
    let t1;
    if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
      t1 = <Text color="promptBorder" dimColor={true}>{LIGHTNING_BOLT}</Text>;
      $[0] = t1;
    } else {
      t1 = $[0];
    }
    return t1;
  }
  let t1;
  if ($[1] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = <Text color="fastMode">{LIGHTNING_BOLT}</Text>;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  return t1;
}
