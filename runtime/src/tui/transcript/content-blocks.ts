import type { LLMContentPart } from "../../llm/types.js";
import type { TranscriptMessage } from "./MessageList.js";

export type UserTranscriptContentBlock =
  | {
      readonly type: "text";
      readonly text: string;
    }
  | {
      readonly type: "image";
      readonly imageId?: number | string;
      readonly imagePath?: string;
      readonly url?: string;
      readonly alt?: string;
    }
  | {
      readonly type: "tool_result";
      readonly toolUseId?: string;
      readonly content: string;
      readonly isError?: boolean;
    }
  | {
      readonly type: "attachment";
      readonly label: string;
      readonly content?: string;
      readonly path?: string;
    };

export type AssistantTranscriptContentBlock =
  | {
      readonly type: "text";
      readonly text: string;
    }
  | {
      readonly type: "thinking";
      readonly text: string;
      readonly signature?: string;
    }
  | {
      readonly type: "redacted_thinking";
      readonly text?: string;
      readonly data?: string;
    }
  | {
      readonly type: "tool_use";
      readonly id?: string;
      readonly name: string;
      readonly input?: unknown;
      readonly isComplete?: boolean;
    };

export type TranscriptAttachmentBlock = {
  readonly type:
    | "queued_command"
    | "file"
    | "image"
    | "local_command"
    | "resource"
    | "unknown";
  readonly label?: string;
  readonly prompt?: string | readonly UserTranscriptContentBlock[];
  readonly content?: string;
  readonly path?: string;
  readonly isMeta?: boolean;
};

type UnknownRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function textFromUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function userBlocksFromLLMContent(
  content: string | readonly LLMContentPart[],
  imagePaths: readonly string[] = [],
): UserTranscriptContentBlock[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }

  let imageIndex = 0;
  return content.map((part): UserTranscriptContentBlock => {
    if (part.type === "image_url") {
      const id = imageIndex + 1;
      const imagePath = imagePaths[imageIndex];
      imageIndex += 1;
      return {
        type: "image",
        imageId: id,
        ...(imagePath !== undefined ? { imagePath } : {}),
        url: part.image_url.url,
      };
    }
    return { type: "text", text: part.text };
  });
}

export function userBlocksFromEventPayload(
  message: unknown,
  imagePaths: readonly string[] = [],
): UserTranscriptContentBlock[] {
  if (Array.isArray(message)) {
    let imageIndex = 0;
    return message.map((part): UserTranscriptContentBlock => {
      if (!isRecord(part)) return { type: "text", text: textFromUnknown(part) };
      const type = part.type;
      if (type === "image" || type === "image_url" || type === "input_image") {
        const id = imageIndex + 1;
        const imagePath = imagePaths[imageIndex];
        imageIndex += 1;
        const imageUrl = isRecord(part.image_url)
          ? textFromUnknown(part.image_url.url)
          : textFromUnknown(part.url);
        return {
          type: "image",
          imageId: id,
          ...(imagePath !== undefined ? { imagePath } : {}),
          ...(imageUrl ? { url: imageUrl } : {}),
          ...(typeof part.alt === "string" ? { alt: part.alt } : {}),
        };
      }
      if (type === "tool_result") {
        return {
          type: "tool_result",
          content: textFromUnknown(part.content),
          ...(typeof part.tool_use_id === "string"
            ? { toolUseId: part.tool_use_id }
            : {}),
          ...(typeof part.is_error === "boolean"
            ? { isError: part.is_error }
            : {}),
        };
      }
      if (type === "attachment") {
        return {
          type: "attachment",
          label: textFromUnknown(part.label || part.name || "attachment"),
          ...(part.content !== undefined
            ? { content: textFromUnknown(part.content) }
            : {}),
          ...(typeof part.path === "string" ? { path: part.path } : {}),
        };
      }
      if (typeof part.text === "string") {
        return { type: "text", text: part.text };
      }
      return { type: "text", text: textFromUnknown(part) };
    });
  }

  const blocks = userBlocksFromLLMContent(textFromUnknown(message), imagePaths);
  if (imagePaths.length === 0) return blocks;
  return [
    ...blocks,
    ...imagePaths.map((imagePath, index) => ({
      type: "image" as const,
      imageId: index + 1,
      imagePath,
    })),
  ];
}

export function assistantBlocksFromUnknown(
  value: unknown,
): AssistantTranscriptContentBlock[] {
  if (Array.isArray(value)) {
    return value.map((part): AssistantTranscriptContentBlock => {
      if (!isRecord(part)) return { type: "text", text: textFromUnknown(part) };
      switch (part.type) {
        case "thinking":
          return {
            type: "thinking",
            text: textFromUnknown(part.thinking ?? part.text),
            ...(typeof part.signature === "string"
              ? { signature: part.signature }
              : {}),
          };
        case "redacted_thinking":
          return {
            type: "redacted_thinking",
            ...(part.text !== undefined ? { text: textFromUnknown(part.text) } : {}),
            ...(typeof part.data === "string" ? { data: part.data } : {}),
          };
        case "tool_use":
          return {
            type: "tool_use",
            name: textFromUnknown(part.name || "tool"),
            ...(typeof part.id === "string" ? { id: part.id } : {}),
            ...(part.input !== undefined ? { input: part.input } : {}),
          };
        case "text":
        default:
          return { type: "text", text: textFromUnknown(part.text ?? part) };
      }
    });
  }
  return [{ type: "text", text: textFromUnknown(value) }];
}

export function userBlockSearchText(block: UserTranscriptContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "image":
      return [block.alt, block.imagePath, block.url, `Image ${block.imageId ?? ""}`]
        .filter(Boolean)
        .join(" ");
    case "tool_result":
      return block.content;
    case "attachment":
      return [block.label, block.content, block.path].filter(Boolean).join(" ");
  }
}

export function assistantBlockSearchText(
  block: AssistantTranscriptContentBlock,
): string {
  switch (block.type) {
    case "text":
    case "thinking":
      return block.text;
    case "redacted_thinking":
      return block.text ?? block.data ?? "redacted thinking";
    case "tool_use":
      return [block.name, textFromUnknown(block.input)].join(" ");
  }
}

export function transcriptMessageSearchText(message: TranscriptMessage): string {
  const parts = [
    message.content,
    ...(message.userContent?.map(userBlockSearchText) ?? []),
    ...(message.assistantContent?.map(assistantBlockSearchText) ?? []),
    ...(message.attachments?.map((attachment) =>
      [attachment.label, attachment.content, attachment.path].filter(Boolean).join(" "),
    ) ?? []),
    message.toolName,
    textFromUnknown(message.toolArgs),
    message.toolProgressContent,
    message.toolResultContent,
    message.execCommand,
    message.execStdout,
    message.execStderr,
    message.slashInput,
  ];
  return parts.filter(Boolean).join("\n").toLowerCase();
}
