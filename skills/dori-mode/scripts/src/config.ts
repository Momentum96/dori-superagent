import { homedir } from "node:os";
import { join } from "node:path";

import type { RuntimeKind, TerminalKind } from "../../../../src/runtime/types.ts";
import { checkRawConfig, ConfigError } from "./config-checks.ts";
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
  /** `dori heavy` admits by free memory and load between these two; the old `heavySlots` key is read as the ceiling. */
  readonly heavyMinSlots: number;
  readonly heavyMaxSlots: number;
  readonly heavyJobMemGb: number;
  readonly heavyMaxLoad: number;
  readonly deadPanePatterns: readonly string[];
  readonly guard: GuardThresholds;
  readonly hooks: Hooks;
  /** Expected Git author and committer per lowercase `owner/repo`, for `verify-pr` and the lane footer. */
  readonly repoIdentities: Readonly<Record<string, CommitIdentity>>;
  readonly supervision: SupervisionOptions;
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
  heavyMinSlots: 1,
  heavyMaxSlots: 4,
  heavyJobMemGb: 4,
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
});

export { ConfigError };

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

export const loadConfig = async (path = configPath(), home = homedir()): Promise<DoriConfig> => {
  const base = defaultConfig(home);
  const file = Bun.file(path);
  const raw = (await file.exists()) ? ((await file.json()) as Partial<DoriConfig>) : {};
  checkRawConfig(raw);
  const merged: DoriConfig = {
    ...base,
    ...raw,
    guard: { ...base.guard, ...raw.guard },
    hooks: { ...base.hooks, ...raw.hooks },
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
    heavyMaxSlots: raw.heavyMaxSlots ?? (raw as { heavySlots?: number }).heavySlots ?? base.heavyMaxSlots,
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
  for (const name of ["heavyMinSlots", "heavyMaxSlots", "heavyJobMemGb", "heavyMaxLoad"] as const) {
    const value = merged[name];
    if (typeof value !== "number" || !Number.isFinite(value) || value < (name === "heavyMinSlots" ? 0 : 1))
      throw new ConfigError(`invalid ${name}: expected a number of at least ${name === "heavyMinSlots" ? 0 : 1}`);
  }
  if (merged.heavyMinSlots > merged.heavyMaxSlots)
    throw new ConfigError("invalid heavyMinSlots: above heavyMaxSlots (or the old heavySlots)");
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
