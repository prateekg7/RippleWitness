const PATTERNS: { re: RegExp; label: string }[] = [
  { re: /Bearer\s+[A-Za-z0-9\-._~+/=]+/g, label: "Bearer [REDACTED]" },
  { re: /sk-[A-Za-z0-9-]{8,}/g, label: "sk-[REDACTED]" },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, label: "[PRIVATE KEY REDACTED]" },
  { re: /(['"]?(?:api[_-]?key|secret|password|passwd|pwd)['"]?\s*[:=]\s*['"]?)([^'"\s,}]+)/gi, label: "$1[REDACTED]" },
  { re: /gh[pousr]_[A-Za-z0-9]{20,}/g, label: "gh_...[REDACTED]" },
];

/** Redact secret-shaped values before any prompt leaves the machine (AGENTS A5.3). Pure. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const { re, label } of PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, label);
  }
  return out;
}
