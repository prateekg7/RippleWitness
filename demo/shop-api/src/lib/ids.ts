export function createIdGen(seed = process.env.SEED ?? "42"): () => string {
  let n = 0;
  return () => `id-${seed}-${++n}`;
}
