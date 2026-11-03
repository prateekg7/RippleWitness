export function createIdGen(seed = process.env.SEED ?? "42") {
  let n = 0;
  return () => `id-${seed}-${++n}`;
}
