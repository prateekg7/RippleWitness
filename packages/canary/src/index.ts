export const PACKAGE_NAME = "@ripplewitness/canary" as const;
export type { CanaryCandidate, CanaryOperator } from "./operators.js";
export { proposeCanary, proposeWith } from "./operators.js";
export type { CanaryVerdict } from "./validate.js";
export { validateCanary } from "./validate.js";
