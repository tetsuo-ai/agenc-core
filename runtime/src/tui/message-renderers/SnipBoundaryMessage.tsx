import React from "react";
import { MessageResponse } from "../components/MessageResponse.js";
import { Text } from "../ink.js";

export function SnipBoundaryMessage(_props: { readonly message: unknown }): React.ReactNode {
  return (
    <MessageResponse>
      <Text dimColor={true}>Earlier conversation snipped</Text>
    </MessageResponse>
  );
}
