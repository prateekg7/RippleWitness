import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const ToneSchema = z.enum(["direct", "neutral", "socratic"]);

/**
 * F-14 reviewer config. Every key has a consumer (no theater): gate feeds the
 * server default, tone feeds the phraser, maxSentences feeds the explainer,
 * style feeds the summary writer. Unknown keys fail fast (strict).
 */
export const ConfigSchema = z
  .object({
    gate: z
      .object({
        minRecall: z.number().min(0).max(1),
        minPrecision: z.number().min(0).max(1),
      })
      .strict()
      .optional(),
    agents: z
      .object({
        questionPhraser: z.object({ tone: ToneSchema }).strict().optional(),
        explainer: z.object({ maxSentences: z.number().int().min(1).max(10) }).strict().optional(),
        summary: z.object({ style: z.string().min(1).max(80) }).strict().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export interface ResolvedConfig {
  gate: { minRecall: number; minPrecision: number };
  tone: "direct" | "neutral" | "socratic";
  explainerMaxSentences: number;
  summaryStyle: string;
}

export const DEFAULT_CONFIG: ResolvedConfig = {
  gate: { minRecall: 0.75, minPrecision: 0.5 },
  tone: "neutral",
  explainerMaxSentences: 5,
  summaryStyle: "",
};

export const CONFIG_FILE = "ripplewitness.config.yaml";

/**
 * Load reviewer config: RIPPLEWITNESS_HOME, else cwd. Missing file =>
 * defaults; present-but-invalid => typed error (serve fails fast).
 */
export function loadConfig(homeDir: string, cwd = process.cwd()): { ok: true; config: ResolvedConfig; path: string | null } | { ok: false; error: string } {
  const candidates = [join(homeDir, CONFIG_FILE), join(cwd, CONFIG_FILE)];
  const path = candidates.find((p) => existsSync(p)) ?? null;
  if (!path) return { ok: true, config: DEFAULT_CONFIG, path: null };
  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(path, "utf8"));
  } catch (err) {
    return { ok: false, error: `${path}: invalid YAML (${String(err).slice(0, 160)})` };
  }
  const parsed = ConfigSchema.safeParse(doc ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first ? [...first.path].join(".") || "(root)" : "(root)";
    return { ok: false, error: `${path}: ${where}: ${first?.message ?? "invalid config"}` };
  }
  const v = parsed.data;
  return {
    ok: true,
    path,
    config: {
      gate: v.gate ?? DEFAULT_CONFIG.gate,
      tone: v.agents?.questionPhraser?.tone ?? DEFAULT_CONFIG.tone,
      explainerMaxSentences: v.agents?.explainer?.maxSentences ?? DEFAULT_CONFIG.explainerMaxSentences,
      summaryStyle: v.agents?.summary?.style ?? DEFAULT_CONFIG.summaryStyle,
    },
  };
}
