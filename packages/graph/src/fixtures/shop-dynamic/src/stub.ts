// Dependency-free Express stand-in for extractor tests (valid TS, never executed).
export type Handler = () => unknown;
export const app = {
  get(_path: string, _h: Handler): void {},
  post(_path: string, _h: Handler): void {},
  use(_prefix: string, _router: unknown): void {},
};
export function Router(): { get(_path: string, _h: Handler): void } {
  return { get(_p: string, _h: Handler): void {} };
}
