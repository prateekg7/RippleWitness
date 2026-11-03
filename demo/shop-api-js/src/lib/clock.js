export function now() {
  return process.env.FROZEN_TIME ?? "2026-01-01T00:00:00Z";
}
