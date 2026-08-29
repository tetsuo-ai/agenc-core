const MAXIMUM_DIAGNOSTIC_CHARACTERS = 2_000;
const OMISSION_MARKER = "\n…\n";

export function formatBoundedDiagnostic(value) {
  const text =
    typeof value === "string" ? value : value.toString("utf8");
  const trimmed = text.trim();
  if (trimmed.length <= MAXIMUM_DIAGNOSTIC_CHARACTERS) return trimmed;

  const retainedCharacters =
    MAXIMUM_DIAGNOSTIC_CHARACTERS - OMISSION_MARKER.length;
  const headCharacters = Math.ceil(retainedCharacters / 2);
  const tailCharacters = retainedCharacters - headCharacters;
  return (
    trimmed.slice(0, headCharacters) +
    OMISSION_MARKER +
    trimmed.slice(-tailCharacters)
  );
}
