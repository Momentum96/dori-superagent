import { homedir } from "node:os";
import { join } from "node:path";

import type { RuntimeKind, TerminalKind } from "../../../../src/runtime/types.ts";
import type { SupervisionOptions } from "./supervision-observe.ts";
import type { CommitIdentity } from "./verify-pr-check.ts";

export type ArgvTemplate = readonly string[];

export type Hooks = {
  readonly threadReply?: ArgvTemplate;
  readonly threadDone?: ArgvTemplate;
  readonly transcribe?: ArgvTemplate;
  /** Run once per lead-inbox item the lead accepted: {id} {kind} {source} {channel} {message} (the last two empty off Discord). */
  readonly inboxAccepted?: ArgvTemplate;
  /** `dori lead replace`: post one line to the status channel, {text}. */
  readonly leadAlert?: ArgvTemplate;
};

export type GuardThresholds = {
  readonly loadAlert: number;
  readonly loadOk: number;
  readonly memFreeMinPct: number;
  readonly diskFreeMinGb: number;
  readonly panesMax: number;
};

export type DoriConfig = {
  /** Where new sessions open; absent = detected (see run.ts runtimeChoice). */
  readonly runtime?: TerminalKind;
  /** Where new lanes open; absent = the same runtime as `runtime`. `omo-host` runs each lane inside omo's shared host. */
  readonly laneRuntime?: RuntimeKind;
  /** Where the lead session lives; absent = the same runtime as `runtime`. Read by lanes to name how they reach the lead. */
  readonly leadRuntime?: RuntimeKind;
  /** Lanes reach the lead through its inbox (`dori report` alone delivers); implied when leadRuntime is omo-host. */
  readonly leadInbox?: boolean;
  /** What `dori forward-reports` hands each envelope to on stdin; absent = this CLI's `lead-inbox put` here. */
  readonly leadInboxArgv?: ArgvTemplate;
  /** This machine's name in forwarded report ids (`r:<machine>:...`, checked there); absent = the short host name. */
  readonly machine?: string;
  readonly stateDir: string;
  readonly laneWorkspace: string;
  readonly workspaces: readonly string[];
  readonly ignorePanes: readonly string[];
  readonly leadPane: string;
  readonly defaultCwd: string;
  readonly agentCommand: ArgvTemplate;
  readonly defaultModel: string;
  readonly launchKeywords: string;
  readonly goalMarker: string;
  /** How long `launch` waits for the agent's ready status and goal after it starts; a slow host is a host property. */
  readonly startupWaitSeconds: number;
  readonly sessionsDir: string;
  readonly nudgeAfterMin: number;
  readonly postAfterMin: number;
  readonly closeAfterMin: number;
  readonly heavySlots: number;
  readonly heavyMaxLoad: number;
  readonly deadPanePatterns: readonly string[];
  readonly guard: GuardThresholds;
  readonly hooks: Hooks;
  /** Expected Git author and committer per lowercase `owner/repo`, for `verify-pr` and the lane footer. */
  readonly repoIdentities: Readonly<Record<string, CommitIdentity>>;
  readonly supervision: SupervisionOptions;
  /** The dori.bot surface: the gateway's local socket. No token; DORI_GATEWAY_SOCKET overrides the path. */
  readonly gateway: { readonly socket: string };
};

export const defaultConfig = (home = homedir()): DoriConfig => ({
  stateDir: join(home, ".dori", "state"),
  laneWorkspace: "",
  workspaces: [],
  ignorePanes: [],
  leadPane: "",
  defaultCwd: home,
  agentCommand: ["omo", "--model", "{model}", "{prompt}"],
  defaultModel: "anthropic/claude-opus-5-5",
  launchKeywords: "ulw set goal and work",
  goalMarker: "Pursuing goal",
  startupWaitSeconds: 180,
  sessionsDir: join(home, ".omo", "agent", "sessions"),
  nudgeAfterMin: 15,
  postAfterMin: 20,
  closeAfterMin: 5,
  heavySlots: 1,
  heavyMaxLoad: 80,
  deadPanePatterns: ["has stopped", "no suitable jobs"],
  guard: { loadAlert: 150, loadOk: 80, memFreeMinPct: 20, diskFreeMinGb: 50, panesMax: 20 },
  hooks: {},
  repoIdentities: {},
  supervision: {
    hungAfterMinutes: 20,
    staleAfterMinutes: 20,
    defaults: { wallMinutes: null, tokens: null, costUsd: null },
  },
  gateway: { socket: "/run/dori-gateway/dori.sock" },
});

export const configPath = (): string => process.env["DORI_CONFIG"] ?? join(homedir(), ".dori", "config.json");

export const expandHome = (path: string, home = homedir()): string =>
  path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;

const isIdentity = (value: unknown): value is CommitIdentity => {
  const v = value as { name?: unknown; email?: unknown } | null;
  return (
    typeof v === "object" &&
    v !== null &&
    typeof v.name === "string" &&
    !!v.name.trim() &&
    typeof v.email === "string" &&
    !!v.email.trim()
  );
};

// The file is untrusted JSON: keep only well-formed identities, so a bad entry reads as an unconfigured repo.
const repoIdentities = (value: unknown): Record<string, CommitIdentity> =>
  typeof value !== "object" || value === null || Array.isArray(value)
    ? {}
    : Object.fromEntries(
        Object.entries(value).flatMap(([repo, identity]) =>
          isIdentity(identity) ? [[repo.toLowerCase(), identity]] : [],
        ),
      );

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

export const loadConfig = async (path = configPath(), home = homedir()): Promise<DoriConfig> => {
  const base = defaultConfig(home);
  const file = Bun.file(path);
  const raw = (await file.exists()) ? ((await file.json()) as Partial<DoriConfig>) : {};
  checkRuntime("runtime", raw.runtime, RUNTIMES);
  checkRuntime("laneRuntime", raw.laneRuntime, LANE_RUNTIMES);
  checkRuntime("leadRuntime", raw.leadRuntime, LANE_RUNTIMES);
  checkSupervision(raw.supervision);
  checkLeadInbox(raw);
  const merged: DoriConfig = {
    ...base,
    ...raw,
    guard: { ...base.guard, ...raw.guard },
    hooks: { ...base.hooks, ...raw.hooks },
    gateway: { ...base.gateway, ...raw.gateway },
    repoIdentities: repoIdentities(raw.repoIdentities),
    // Only a string is a marker: null or false would quietly turn the goal check off, and an object would never show.
    goalMarker: typeof raw.goalMarker === "string" ? raw.goalMarker : base.goalMarker,
    // Only a nonnegative number is a wait: a string or null would otherwise end every launch at the first check.
    startupWaitSeconds:
      typeof raw.startupWaitSeconds === "number" &&
      Number.isFinite(raw.startupWaitSeconds) &&
      raw.startupWaitSeconds >= 0
        ? raw.startupWaitSeconds
        : base.startupWaitSeconds,
    supervision: {
      ...base.supervision,
      ...raw.supervision,
      defaults: { ...base.supervision.defaults, ...raw.supervision?.defaults },
    },
  };
  for (const [name, value] of Object.entries({
    hungAfterMinutes: merged.supervision.hungAfterMinutes,
    staleAfterMinutes: merged.supervision.staleAfterMinutes,
    ...merged.supervision.defaults,
  })) {
    if (value != null && (typeof value !== "number" || !Number.isFinite(value) || value < 0))
      throw new ConfigError(`invalid supervision ${name}: expected a nonnegative number or null`);
  }
  for (const [key, budget] of Object.entries(merged.supervision.lanes ?? {})) {
    for (const [name, value] of Object.entries(budget)) {
      if (value != null && (typeof value !== "number" || !Number.isFinite(value) || value < 0))
        throw new ConfigError(`invalid supervision lanes.${key}.${name}: expected a nonnegative number or null`);
    }
  }
  return {
    ...merged,
    stateDir: expandHome(process.env["DORI_STATE_DIR"] ?? merged.stateDir, home),
    defaultCwd: expandHome(merged.defaultCwd, home),
    sessionsDir: expandHome(merged.sessionsDir, home),
    leadPane: process.env["DORI_LEAD_PANE"] ?? merged.leadPane,
  };
};

export const fill = (template: ArgvTemplate, values: Readonly<Record<string, string>>): string[] =>
  template.map((part) => part.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole));
