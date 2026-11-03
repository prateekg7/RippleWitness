import { DEFAULT_ATOL, DEFAULT_RTOL, numbersClose } from "./diff.js";
import type { ToleranceSpec } from "./diff.js";

/**
 * Deep predicted-vs-actual match for F-10. Objects compare by key set,
 * arrays by length and element, numbers by tolerance (exact unless a
 * ToleranceSpec covers the path). Pure.
 */
export function valuesMatch(
  predicted: unknown,
  actual: unknown,
  tolerances: ToleranceSpec[] = [],
  path = "$",
): boolean {
  if (typeof predicted === "number" && typeof actual === "number") {
    return numbersClose(predicted, actual, specFor(path, tolerances)).close;
  }
  if (Array.isArray(predicted) || Array.isArray(actual)) {
    return (
      Array.isArray(predicted) &&
      Array.isArray(actual) &&
      predicted.length === actual.length &&
      predicted.every((p, i) => valuesMatch(p, actual[i], tolerances, `${path}[${i}]`))
    );
  }
  if (isRecord(predicted) || isRecord(actual)) {
    if (!isRecord(predicted) || !isRecord(actual)) return false;
    const keys = new Set([...Object.keys(predicted), ...Object.keys(actual)]);
    return [...keys].every((k) => k in predicted && k in actual && valuesMatch(predicted[k], actual[k], tolerances, `${path}.${k}`));
  }
  return Object.is(predicted, actual);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function specFor(path: string, tolerances: ToleranceSpec[]): Pick<ToleranceSpec, "rtol" | "atol" | "nanEqual"> {
  const hit = tolerances.find((t) => path === t.path || path.startsWith(`${t.path}.`) || path.startsWith(`${t.path}[`));
  return { rtol: hit?.rtol ?? DEFAULT_RTOL, atol: hit?.atol ?? DEFAULT_ATOL, nanEqual: hit?.nanEqual };
}
