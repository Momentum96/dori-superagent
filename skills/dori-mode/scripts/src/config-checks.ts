/** The checks on the untrusted config file: a value of the wrong shape stops the load with its name. */
import type { RuntimeKind, TerminalKind } from "../../../../src/runtime/types.ts";

export class ConfigError extends Error {}

const checkLeadInbox = (raw: Readonly<Record<string, unknown>>): void => {
  if (raw["leadInbox"] !== undefined && typeof raw["leadInbox"] !== "boolean")
    throw new ConfigError("invalid leadInbox: expected true or false");
  const argv = raw["leadInboxArgv"];
  if (argv !== undefined && !(Array.isArray(argv) && argv.length > 0 && argv.every((a) => typeof a === "string" && a)))
    throw new ConfigError("invalid leadInboxArgv: expected a non-empty array of non-empty strings");
};

const RUNTIMES: Readonly<Record<TerminalKind, true>> = { herdr: true, hc: true };
const LANE_RUNTIMES: Readonly<Record<RuntimeKind, true>> = { ...RUNTIMES, "omo-host": true };
const checkRuntime = (name: string, value: unknown, allowed: Readonly<Record<string, true>>): void => {
  if (value !== undefined && !(typeof value === "string" && Object.hasOwn(allowed, value)))
    throw new ConfigError(
      `invalid ${name}: expected ${Object.keys(allowed)
        .map((k) => JSON.stringify(k))
        .join(" or ")}, got ${JSON.stringify(value)}`,
    );
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const SUPERVISION_KEYS = new Set([
  "hungAfterMinutes",
  "staleAfterMinutes",
  "defaults",
  "lanes",
  "usageArgv",
  "recordCostArgv",
  "activityPaths",
  "gitActivity",
]);
const CEILINGS = new Set(["wallMinutes", "tokens", "costUsd"]);
const checkCeilingNames = (where: string, budget: Record<string, unknown>): void => {
  for (const name of Object.keys(budget)) {
    if (!CEILINGS.has(name))
      throw new ConfigError(
        `invalid supervision ${where}.${name}: unknown ceiling (expected wallMinutes, tokens or costUsd)`,
      );
  }
};

// A malformed supervision entry stops with its name: dropping it could turn a ceiling off, and keeping it would crash
// every sweep later. A misspelt name is refused for the same reason.
const checkSupervision = (value: unknown): void => {
  if (value === undefined) return;
  if (!isRecord(value)) throw new ConfigError("invalid supervision: expected an object");
  for (const name of Object.keys(value)) {
    if (!SUPERVISION_KEYS.has(name)) throw new ConfigError(`invalid supervision ${name}: unknown setting`);
  }
  for (const name of ["defaults", "lanes"] as const) {
    if (value[name] !== undefined && !isRecord(value[name]))
      throw new ConfigError(`invalid supervision ${name}: expected an object`);
  }
  if (isRecord(value["defaults"])) checkCeilingNames("defaults", value["defaults"]);
  for (const [key, budget] of Object.entries(isRecord(value["lanes"]) ? value["lanes"] : {})) {
    if (!isRecord(budget)) throw new ConfigError(`invalid supervision lanes.${key}: expected an object`);
    checkCeilingNames(`lanes.${key}`, budget);
  }
  for (const name of ["usageArgv", "recordCostArgv", "activityPaths"] as const) {
    const list = value[name];
    if (list !== undefined && !(Array.isArray(list) && list.every((item) => typeof item === "string"))) {
      throw new ConfigError(`invalid supervision ${name}: expected an array of strings`);
    }
  }
  if (value["gitActivity"] !== undefined && typeof value["gitActivity"] !== "boolean")
    throw new ConfigError("invalid supervision gitActivity: expected true or false");
};

export const checkRawConfig = (raw: Readonly<Record<string, unknown>>): void => {
  checkRuntime("runtime", raw["runtime"], RUNTIMES);
  checkRuntime("laneRuntime", raw["laneRuntime"], LANE_RUNTIMES);
  checkRuntime("leadRuntime", raw["leadRuntime"], LANE_RUNTIMES);
  checkSupervision(raw["supervision"]);
  checkLeadInbox(raw);
};
