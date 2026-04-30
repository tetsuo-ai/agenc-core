import React from "react";

import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import { ClickableImageRef } from "../../design-system/ClickableImageRef.js";

export interface UserImageMessageProps {
  readonly imageId?: number | string;
  readonly imagePath?: string;
  readonly url?: string;
  readonly alt?: string;
  readonly addMargin?: boolean;
}

export function UserImageMessage({
  imageId = 1,
  imagePath,
  url,
  alt,
  addMargin = true,
}: UserImageMessageProps): React.ReactElement {
  const numericId =
    typeof imageId === "number"
      ? imageId
      : Number.parseInt(String(imageId), 10) || 1;
  return (
    <Box flexDirection="row" marginTop={addMargin ? 1 : 0}>
      <ClickableImageRef imageId={numericId} imagePath={imagePath} />
      {alt || url ? <Text dimColor> {alt ?? url}</Text> : null}
    </Box>
  );
}

export default UserImageMessage;
