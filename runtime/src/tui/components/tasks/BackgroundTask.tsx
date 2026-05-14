import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import { Text } from '../../ink.js';
import type { BackgroundTaskState } from 'src/tasks/types.js';
import type { DeepImmutable } from '../../../types/utils.js';
import { truncate } from '../../../utils/format.js'; // upstream-import: keep target is owned by another Z-PURGE item
import { toInkColor } from '../../../utils/ink.js'; // upstream-import: keep target is owned by another Z-PURGE item
import { DIAMOND_FILLED, DIAMOND_OPEN } from '../../../constants/figures'; // upstream-import: keep target is owned by another Z-PURGE item
import { RemoteSessionProgress } from './RemoteSessionProgress';
import { ShellProgress, TaskStatusText } from './ShellProgress';
import { describeTeammateActivity } from './taskStatusUtils';
type Props = {
  task: DeepImmutable<BackgroundTaskState>;
  maxActivityWidth?: number;
};
export function BackgroundTask(t0) {
  const $ = _c(54);
  const {
    task,
    maxActivityWidth
  } = t0;
  const activityLimit = maxActivityWidth ?? 40;
  switch (task.type) {
    case "local_bash":
      {
        const t1 = task.kind === "monitor" ? task.description : task.command;
        let t2;
        if ($[0] !== activityLimit || $[1] !== t1) {
          t2 = truncate(t1, activityLimit, true);
          $[0] = activityLimit;
          $[1] = t1;
          $[2] = t2;
        } else {
          t2 = $[2];
        }
        let t3;
        if ($[3] !== task) {
          t3 = <ShellProgress shell={task} />;
          $[3] = task;
          $[4] = t3;
        } else {
          t3 = $[4];
        }
        let t4;
        if ($[5] !== t2 || $[6] !== t3) {
          t4 = <Text>{t2}{" "}{t3}</Text>;
          $[5] = t2;
          $[6] = t3;
          $[7] = t4;
        } else {
          t4 = $[7];
        }
        return t4;
      }
    case "remote_agent":
      {
        if (task.isRemoteReview) {
          let t1;
          if ($[8] !== task) {
            t1 = <Text><RemoteSessionProgress session={task} /></Text>;
            $[8] = task;
            $[9] = t1;
          } else {
            t1 = $[9];
          }
          return t1;
        }
        const running = task.status === "running" || task.status === "pending";
        const t1 = running ? DIAMOND_OPEN : DIAMOND_FILLED;
        let t2;
        if ($[10] !== t1) {
          t2 = <Text dimColor={true}>{t1} </Text>;
          $[10] = t1;
          $[11] = t2;
        } else {
          t2 = $[11];
        }
        let t3;
        if ($[12] !== activityLimit || $[13] !== task.title) {
          t3 = truncate(task.title, activityLimit, true);
          $[12] = activityLimit;
          $[13] = task.title;
          $[14] = t3;
        } else {
          t3 = $[14];
        }
        let t4;
        if ($[15] === Symbol.for("react.memo_cache_sentinel")) {
          t4 = <Text dimColor={true}> · </Text>;
          $[15] = t4;
        } else {
          t4 = $[15];
        }
        let t5;
        if ($[16] !== task) {
          t5 = <RemoteSessionProgress session={task} />;
          $[16] = task;
          $[17] = t5;
        } else {
          t5 = $[17];
        }
        let t6;
        if ($[18] !== t2 || $[19] !== t3 || $[20] !== t5) {
          t6 = <Text>{t2}{t3}{t4}{t5}</Text>;
          $[18] = t2;
          $[19] = t3;
          $[20] = t5;
          $[21] = t6;
        } else {
          t6 = $[21];
        }
        return t6;
      }
    case "local_agent":
      {
        let t1;
        if ($[22] !== activityLimit || $[23] !== task.description) {
          t1 = truncate(task.description, activityLimit, true);
          $[22] = activityLimit;
          $[23] = task.description;
          $[24] = t1;
        } else {
          t1 = $[24];
        }
        const t2 = task.status === "completed" ? "done" : undefined;
        const t3 = task.status === "completed" && !task.notified ? ", unread" : undefined;
        let t4;
        if ($[25] !== t2 || $[26] !== t3 || $[27] !== task.status) {
          t4 = <TaskStatusText status={task.status} label={t2} suffix={t3} />;
          $[25] = t2;
          $[26] = t3;
          $[27] = task.status;
          $[28] = t4;
        } else {
          t4 = $[28];
        }
        let t5;
        if ($[29] !== t1 || $[30] !== t4) {
          t5 = <Text>{t1}{" "}{t4}</Text>;
          $[29] = t1;
          $[30] = t4;
          $[31] = t5;
        } else {
          t5 = $[31];
        }
        return t5;
      }
    case "in_process_teammate":
      {
        let T0;
        let T1;
        let t1;
        let t2;
        let t3;
        let t4;
        if ($[32] !== activityLimit || $[33] !== task) {
          const activity = describeTeammateActivity(task);
          T1 = Text;
          let t5;
          if ($[40] !== task.identity.color) {
            t5 = toInkColor(task.identity.color);
            $[40] = task.identity.color;
            $[41] = t5;
          } else {
            t5 = $[41];
          }
          if ($[42] !== t5 || $[43] !== task.identity.agentName) {
            t4 = <Text color={t5}>@{task.identity.agentName}</Text>;
            $[42] = t5;
            $[43] = task.identity.agentName;
            $[44] = t4;
          } else {
            t4 = $[44];
          }
          T0 = Text;
          t1 = true;
          t2 = ": ";
          t3 = truncate(activity, activityLimit, true);
          $[32] = activityLimit;
          $[33] = task;
          $[34] = T0;
          $[35] = T1;
          $[36] = t1;
          $[37] = t2;
          $[38] = t3;
          $[39] = t4;
        } else {
          T0 = $[34];
          T1 = $[35];
          t1 = $[36];
          t2 = $[37];
          t3 = $[38];
          t4 = $[39];
        }
        let t5;
        if ($[45] !== T0 || $[46] !== t1 || $[47] !== t2 || $[48] !== t3) {
          t5 = <T0 dimColor={t1}>{t2}{t3}</T0>;
          $[45] = T0;
          $[46] = t1;
          $[47] = t2;
          $[48] = t3;
          $[49] = t5;
        } else {
          t5 = $[49];
        }
        let t6;
        if ($[50] !== T1 || $[51] !== t4 || $[52] !== t5) {
          t6 = <T1>{t4}{t5}</T1>;
          $[50] = T1;
          $[51] = t4;
          $[52] = t5;
          $[53] = t6;
        } else {
          t6 = $[53];
        }
        return t6;
      }
  }
}
