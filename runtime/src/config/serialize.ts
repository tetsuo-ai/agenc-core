import { cloneRecord, isPlainRecord, type JsonRecord } from "./json.js";

function quoteTomlString(value: string): string {
  let encoded = "";
  for (const character of value) {
    switch (character) {
      case "\b":
        encoded += "\\b";
        break;
      case "\t":
        encoded += "\\t";
        break;
      case "\n":
        encoded += "\\n";
        break;
      case "\f":
        encoded += "\\f";
        break;
      case "\r":
        encoded += "\\r";
        break;
      case '"':
        encoded += '\\"';
        break;
      case "\\":
        encoded += "\\\\";
        break;
      default: {
        const codePoint = character.codePointAt(0) ?? 0;
        if (
          codePoint <= 0x08 ||
          (codePoint >= 0x0b && codePoint <= 0x1f) ||
          codePoint === 0x7f
        ) {
          encoded += `\\u${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
        } else {
          encoded += character;
        }
      }
    }
  }
  return `"${encoded}"`;
}

function tableName(path: readonly string[]): string {
  return path.map(quoteTomlString).join(".");
}

function serializeInlineValue(value: unknown): string {
  if (typeof value === "string") return quoteTomlString(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => serializeInlineValue(item)).join(", ")}]`;
  }
  if (isPlainRecord(value)) {
    const parts = Object.keys(value)
      .sort()
      .map((key) => `${quoteTomlString(key)} = ${serializeInlineValue(value[key])}`);
    return `{ ${parts.join(", ")} }`;
  }
  throw new Error(`unsupported TOML value: ${String(value)}`);
}

function serializeRecordBody(record: JsonRecord): {
  readonly fields: string[];
  readonly tables: Array<readonly [string, JsonRecord]>;
} {
  const fields: string[] = [];
  const tables: Array<readonly [string, JsonRecord]> = [];
  for (const key of Object.keys(record).sort()) {
    const value = record[key];
    if (isPlainRecord(value)) {
      tables.push([key, value]);
    } else {
      fields.push(`${quoteTomlString(key)} = ${serializeInlineValue(value)}`);
    }
  }
  return { fields, tables };
}

/** Serialize one canonical config document deterministically as TOML. */
export function serializeConfigToml(
  raw: Readonly<Record<string, unknown>>,
): string {
  const lines: string[] = [];

  function writeTable(path: readonly string[], record: JsonRecord): void {
    const { fields, tables } = serializeRecordBody(record);
    if (path.length > 0) {
      if (lines.length > 0) lines.push("");
      lines.push(`[${tableName(path)}]`);
    }
    lines.push(...fields);
    for (const [key, value] of tables) {
      writeTable([...path, key], value);
    }
  }

  writeTable([], cloneRecord(raw));
  return `${lines.join("\n").trim()}\n`;
}
