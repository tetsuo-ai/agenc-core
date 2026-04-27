import React, { useRef } from "react";

import Box from "../ink/components/Box.js";

export interface OffscreenFreezeProps {
  readonly children: React.ReactNode;
  readonly cacheKey: string;
  readonly freeze?: boolean;
}

export function OffscreenFreeze({
  children,
  cacheKey,
  freeze = false,
}: OffscreenFreezeProps): React.ReactElement {
  const cached = useRef<React.ReactNode>(children);
  const keyRef = useRef<string>(cacheKey);
  if (!freeze || keyRef.current !== cacheKey) {
    cached.current = children;
    keyRef.current = cacheKey;
  }
  return <Box flexDirection="column">{cached.current}</Box>;
}

export default OffscreenFreeze;
