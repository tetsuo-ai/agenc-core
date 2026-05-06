import React from "react";

interface OnboardingBoxProps {
  readonly children?: React.ReactNode;
  readonly flexDirection?: "column" | "row";
  readonly marginTop?: number;
  readonly paddingX?: number;
  readonly width?: string | number;
}

interface OnboardingTextProps {
  readonly children?: React.ReactNode;
  readonly bold?: boolean;
  readonly dimColor?: boolean;
}

export function OnboardingBox({
  children,
  flexDirection,
  marginTop,
  paddingX,
  width,
}: OnboardingBoxProps): React.ReactElement {
  const style: Record<string, unknown> = {};
  if (flexDirection !== undefined) style.flexDirection = flexDirection;
  if (marginTop !== undefined) style.marginTop = marginTop;
  if (paddingX !== undefined) {
    style.paddingLeft = paddingX;
    style.paddingRight = paddingX;
  }
  if (width !== undefined) style.width = width;
  return React.createElement("ink-box", { style }, children);
}

export function OnboardingText({
  children,
  bold = false,
  dimColor = false,
}: OnboardingTextProps): React.ReactElement {
  return React.createElement(
    "ink-text",
    {
      textStyles: {
        ...(bold ? { bold: true } : {}),
        ...(dimColor ? { dim: true } : {}),
      },
    },
    children,
  );
}
