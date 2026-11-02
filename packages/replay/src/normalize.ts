/**
 * Mask config entries look like "$..createdAt": only the trailing key name
 * is significant — every matching key at any depth is replaced.
 */
export function maskKeys(patterns: string[]): Set<string> {
  return new Set(patterns.map((p) => p.split(".").pop() as string));
}

export const VOLATILE_VALUE = "<volatile>";

function maskValue(value: unknown, keys: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((v) => maskValue(v, keys));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = keys.has(k) ? VOLATILE_VALUE : maskValue(v, keys);
    }
    return out;
  }
  return value;
}

/** Deep-normalize an observation body: mask volatile keys. Pure. */
export function normalizeBody(body: unknown, maskPatterns: string[]): unknown {
  if (maskPatterns.length === 0) return body;
  return maskValue(body, maskKeys(maskPatterns));
}
