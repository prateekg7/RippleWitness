// Determinism interposition for Node subjects (F-22, TRD §7.4).
// Loaded via NODE_OPTIONS=--require. Freezes Date.now to FROZEN_TIME and
// seeds Math.random from SEED (LCG). Best-effort UUID determinism; anything
// that cannot be patched is left alone (the flake guard still catches drift).
"use strict";

const frozen = Date.parse(process.env.FROZEN_TIME ?? "2026-01-01T00:00:00Z");
let seed = (Number(process.env.SEED ?? 42) >>> 0) || 1;

Date.now = () => frozen;
Math.random = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0x100000000;
};

try {
  const crypto = require("node:crypto");
  let n = 0;
  crypto.randomUUID = () => {
    n += 1;
    const h = (n * 2654435761) >>> 0;
    const p = h.toString(16).padStart(8, "0");
    return `${p.slice(0, 8)}-0000-4000-8000-${String(n).padStart(12, "0").slice(-12)}`;
  };
} catch {
  // crypto namespace not patchable on this runtime — leave it.
}
