/**
 * Blank-aware env read: `.env.example` ships empty placeholders, so a
 * sourced blank (`VAR=`) must behave as unset rather than as an empty
 * override. Trims incidental whitespace/newlines from pasted values.
 */
export function envText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
