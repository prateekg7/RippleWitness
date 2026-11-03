export const PACKAGE_NAME = "@ripplewitness/replay" as const;
export type {
  DiffKind,
  DiffOptions,
  FieldDiff,
  RouteDiff,
  StepDiff,
  ToleratedField,
  ToleranceSpec,
} from "./diff.js";
export { aggregateByRoute, DEFAULT_ATOL, DEFAULT_RTOL, diffSteps, numbersClose, resolveStepRoutes } from "./diff.js";
export type { FlakeResult } from "./flake.js";
export { detectVolatile, learnMasks } from "./flake.js";
export { normalizeBody, maskKeys } from "./normalize.js";
export { createWorktree, removeWorktree, revParse } from "./git.js";
export { discoverGoStartCommand, discoverStartCommand, ensureDeps, hashManifests, pnpmLauncher } from "./deps.js";
export type { DepStrategy } from "./deps.js";
export { isPortFree, pickFreePort, resolvePort } from "./ports.js";
export type { SandboxReport } from "./sandbox.js";
export { REPLAY_ENV_DENY, describeSandbox, scrubEnv, unsetProxies } from "./sandbox.js";
export { ProcRegistry } from "./proc.js";
export { hashDb } from "./dbhash.js";
export { loadScenarios, runComputeSide, runReplay, runSide } from "./runner.js";
export type { HarImportOptions, HarScenario, HarScenarioStep } from "./har.js";
export { harToScenarios, writeHarScenarios } from "./har.js";
export { valuesMatch } from "./values.js";
export type { CandidateScenario, HarvestedCall, HarvestedTest, HarvestError, HarvestFlip, HarvestResult } from "./harvest.js";
export { diffHarvest, harvestToScenarios, provisionHarvestEnv, runHarvest } from "./harvest.js";
export type { ReplayOptions, ReplayResult, SideResult, StepObservation } from "./types.js";
