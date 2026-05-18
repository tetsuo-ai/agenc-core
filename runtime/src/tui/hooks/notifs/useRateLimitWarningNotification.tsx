// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNotifications } from '../../context/notifications.js';
import { Text } from '../../ink.js';
import { getRateLimitWarning, getUsingOverageText } from 'src/services/agencAiLimits.js';
import { useAgenCAiLimits } from 'src/services/agencAiLimitsHook.js';
import { getSubscriptionType } from '../../../utils/auth.js'; // upstream-import: keep target is owned by another Z-PURGE item
import { hasAgenCAiBillingAccess } from '../../../utils/billing.js'; // upstream-import: keep target is owned by another Z-PURGE item
import { getIsRemoteMode } from '../../../bootstrap/state';
export function useRateLimitWarningNotification(model) {
  const $ = _c(17);
  const {
    addNotification
  } = useNotifications();
  const agencAiLimits = useAgenCAiLimits();
  let t0;
  if ($[0] !== agencAiLimits || $[1] !== model) {
    t0 = getRateLimitWarning(agencAiLimits, model);
    $[0] = agencAiLimits;
    $[1] = model;
    $[2] = t0;
  } else {
    t0 = $[2];
  }
  const rateLimitWarning = t0;
  let t1;
  if ($[3] !== agencAiLimits) {
    t1 = getUsingOverageText(agencAiLimits);
    $[3] = agencAiLimits;
    $[4] = t1;
  } else {
    t1 = $[4];
  }
  const usingOverageText = t1;
  const shownWarningRef = useRef(null);
  let t2;
  if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = getSubscriptionType();
    $[5] = t2;
  } else {
    t2 = $[5];
  }
  const subscriptionType = t2;
  let t3;
  if ($[6] === Symbol.for("react.memo_cache_sentinel")) {
    t3 = hasAgenCAiBillingAccess();
    $[6] = t3;
  } else {
    t3 = $[6];
  }
  const hasBillingAccess = t3;
  const isTeamOrEnterprise = subscriptionType === "team" || subscriptionType === "enterprise";
  const [hasShownOverageNotification, setHasShownOverageNotification] = useState(false);
  let t4;
  let t5;
  if ($[7] !== addNotification || $[8] !== agencAiLimits.isUsingOverage || $[9] !== hasShownOverageNotification || $[10] !== usingOverageText) {
    t4 = () => {
      if (getIsRemoteMode()) {
        return;
      }
      if (agencAiLimits.isUsingOverage && !hasShownOverageNotification && (!isTeamOrEnterprise || hasBillingAccess)) {
        addNotification({
          key: "limit-reached",
          text: usingOverageText,
          priority: "immediate"
        });
        setHasShownOverageNotification(true);
      } else {
        if (!agencAiLimits.isUsingOverage && hasShownOverageNotification) {
          setHasShownOverageNotification(false);
        }
      }
    };
    t5 = [agencAiLimits.isUsingOverage, usingOverageText, hasShownOverageNotification, addNotification, hasBillingAccess, isTeamOrEnterprise];
    $[7] = addNotification;
    $[8] = agencAiLimits.isUsingOverage;
    $[9] = hasShownOverageNotification;
    $[10] = usingOverageText;
    $[11] = t4;
    $[12] = t5;
  } else {
    t4 = $[11];
    t5 = $[12];
  }
  useEffect(t4, t5);
  let t6;
  let t7;
  if ($[13] !== addNotification || $[14] !== rateLimitWarning) {
    t6 = () => {
      if (getIsRemoteMode()) {
        return;
      }
      if (rateLimitWarning && rateLimitWarning !== shownWarningRef.current) {
        shownWarningRef.current = rateLimitWarning;
        addNotification({
          key: "rate-limit-warning",
          jsx: <Text><Text color="warning">{rateLimitWarning}</Text></Text>,
          priority: "high"
        });
      }
    };
    t7 = [rateLimitWarning, addNotification];
    $[13] = addNotification;
    $[14] = rateLimitWarning;
    $[15] = t6;
    $[16] = t7;
  } else {
    t6 = $[15];
    t7 = $[16];
  }
  useEffect(t6, t7);
}
