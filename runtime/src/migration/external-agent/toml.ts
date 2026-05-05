export type TomlPrimitive = string | number | boolean;
export type TomlValue =
  | TomlPrimitive
  | readonly TomlValue[]
  | { readonly [key: string]: TomlValue };

export type TomlTable = { readonly [key: string]: TomlValue };

function isTable(value: TomlValue): value is TomlTable {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function isTomlArray(value: TomlValue): value is readonly TomlValue[] {
  return Array.isArray(value);
}

function keyPart(part: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(part)) return part;
  return `"${escapeTomlString(part)}"`;
}

function dottedKey(parts: readonly string[]): string {
  return parts.map(keyPart).join(".");
}

function escapeTomlString(value: string): string {
  let escaped = "";
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    switch (ch) {
      case "\\":
        escaped += "\\\\";
        break;
      case "\t":
        escaped += "\\t";
        break;
      case "\n":
        escaped += "\\n";
        break;
      case "\r":
        escaped += "\\r";
        break;
      case '"':
        escaped += '\\"';
        break;
      default:
        if (code < 0x20 || code === 0x7f) {
          throw new Error(
            `Cannot render TOML string containing control character U+${code.toString(16).padStart(4, "0")}`,
          );
        }
        escaped += ch;
        break;
    }
  }
  return escaped;
}

function renderScalar(value: TomlPrimitive): string {
  if (typeof value === "string") return `"${escapeTomlString(value)}"`;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (!Number.isFinite(value)) {
    throw new Error(`Cannot render non-finite TOML number: ${value}`);
  }
  return String(value);
}

function renderValue(value: TomlValue): string {
  if (isTomlArray(value)) {
    return `[${value.map(renderValue).join(", ")}]`;
  }
  if (isTable(value)) {
    throw new Error("Inline TOML tables are not emitted by this serializer");
  }
  return renderScalar(value);
}

function sortedEntries(table: TomlTable): Array<[string, TomlValue]> {
  return Object.entries(table).sort(([left], [right]) =>
    left.localeCompare(right),
  );
}

function renderTableBody(table: TomlTable, prefix: readonly string[]): string[] {
  const lines: string[] = [];
  const childTables: Array<[string, TomlTable]> = [];

  for (const [key, value] of sortedEntries(table)) {
    if (isTable(value)) {
      childTables.push([key, value]);
    } else {
      lines.push(`${keyPart(key)} = ${renderValue(value)}`);
    }
  }

  for (const [key, child] of childTables) {
    if (lines.length > 0 && lines[lines.length - 1] !== "") {
      lines.push("");
    }
    const childPath = [...prefix, key];
    lines.push(`[${dottedKey(childPath)}]`);
    lines.push(...renderTableBody(child, childPath));
  }

  return lines;
}

export function renderTomlDocument(table: TomlTable): string {
  const lines = renderTableBody(table, []);
  if (lines.length === 0) return "";
  return `${lines.join("\n").replace(/\n+$/g, "")}\n`;
}
