/**
 * Which session is a bot's lead, and the only code that changes it: `open` names the first one, `replace` retires it
 * for a new one, `status` reads lead/<bot>.json. A host session gets its rules in its first prompt (`--prompt @FILE`,
 * spike S1 `rulesMechanism: first-prompt`); nothing is written into its cwd. Every call names the durable session id,
 * never the name `dori-lead-<bot>`: after a host restart a retained session keeps its name, so a name can be ambiguous.
 */
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

import type { Exec } from "../../../../src/runtime/exec.ts";
import type { HostEngine } from "../../../../src/runtime/omo-host/engine.ts";
import { type HostCall, hostCaller, isReason, rec, str } from "../../../../src/runtime/omo-host/exec.ts";
import { type CloseFailure, type LeadState, readLeadState, writeLeadState } from "./lead-state.ts";
import { type Clock, iso } from "./run.ts";

/** A refused request: `code` 2 for bad input, 3 for a lead state that does not allow it. Nothing was changed. */
export class LeadSessionError extends Error {
  constructor(
    message: string,
    readonly code: 2 | 3,
  ) {
    super(message);
  }
}

export type LeadSessionDeps = {
  readonly stateDir: string;
  readonly exec: Exec;
  readonly clock: Clock;
  /** Posts one line to the status channel; a failed post is the caller's to log, never a reason to stop. */
  readonly alert: (text: string) => Promise<void>;
};

export type OpenInput = {
  readonly bot: string;
  readonly cwd: string;
  readonly runtime: "omo-host" | "hc";
  readonly engine?: HostEngine | undefined;
  readonly model?: string;
  readonly rulesFile?: string;
  readonly pane?: string;
};

export type ReplaceInput = {
  readonly bot: string;
  readonly rulesFile: string;
  readonly model?: string;
  readonly engine?: HostEngine | undefined;
};

export type ReplaceResult = {
  readonly lead: LeadState;
  readonly retired: string;
  /** The host answered `closed:false`; the old session may still run, and it is never named again. */
  readonly closeFailure?: CloseFailure;
  /** Open sessions named like this lead that lead.json does not know: left by an earlier replace cut off after open. */
  readonly orphans: readonly string[];
};

export const leadName = (bot: string): string => `dori-lead-${bot}`;

const absoluteFile = (flag: string, path: string | undefined): string => {
  if (path === undefined || !isAbsolute(path)) throw new LeadSessionError(`--${flag} must be an absolute path`, 2);
  if (!existsSync(path)) throw new LeadSessionError(`--${flag} ${path} does not exist`, 2);
  return path;
};

const openHostSession = async (
  call: HostCall,
  spec: { readonly bot: string; readonly cwd: string; readonly model: string; readonly rulesFile: string },
): Promise<string> => {
  const opened = await call([
    "open",
    "--cwd",
    spec.cwd,
    "--model",
    spec.model,
    "--name",
    leadName(spec.bot),
    "--prompt",
    `@${spec.rulesFile}`,
  ]);
  const id = str(opened["durableSessionId"]);
  if (id === undefined) throw new Error("host session open did not return a durableSessionId");
  return id;
};

export const openLead = async (d: LeadSessionDeps, input: OpenInput): Promise<LeadState> => {
  const existing = await readLeadState(d.stateDir, input.bot);
  if (existing !== null)
    throw new LeadSessionError(
      `lead/${input.bot}.json already names ${existing.sessionId} (${existing.state}); use dori lead replace`,
      3,
    );
  const cwd = absoluteFile("cwd", input.cwd);
  const base = { bot: input.bot, generation: 1, state: "active", retired: [], cwd } as const;
  if (input.runtime === "hc") {
    if (input.engine !== undefined) throw new LeadSessionError("--engine needs --runtime omo-host", 2);
    if (input.pane === undefined) throw new LeadSessionError("--runtime hc needs --pane ID", 2);
    const lead: LeadState = { ...base, runtime: "hc", sessionId: input.pane };
    writeLeadState(d.stateDir, lead);
    return lead;
  }
  if (input.model === undefined) throw new LeadSessionError("--model is required for an omo-host lead", 2);
  const rulesFile = absoluteFile("rules", input.rulesFile);
  const engine = input.engine ?? "omo";
  const sessionId = await openHostSession(hostCaller(d.exec, engine), {
    bot: input.bot,
    cwd,
    model: input.model,
    rulesFile,
  });
  const lead: LeadState = { ...base, runtime: "omo-host", engine, sessionId, rules: "first-prompt", rulesFile };
  writeLeadState(d.stateDir, lead);
  return lead;
};

/** `provider/id` of the session's model, from `state` (asked only while the session is still the active lead). */
const modelOf = async (call: HostCall, id: string): Promise<string | undefined> => {
  const model = rec(rec((await call(["state", id]))["state"])["model"]);
  const [provider, name] = [str(model["provider"]), str(model["id"])];
  return provider === undefined || name === undefined ? undefined : `${provider}/${name}`;
};

/**
 * `close` the retiring session once. `closed:false` (a session resumed after a host restart refused it twice in spike
 * S1) is recorded and alerted, and the replace goes on: the old id is never named again, not even by `state`, which
 * would revive a closed session. A session the host does not know is already gone.
 */
const closeOld = async (call: HostCall, clock: Clock, id: string): Promise<CloseFailure | undefined> => {
  let answer: Record<string, unknown>;
  try {
    answer = await call(["close", id]);
  } catch (e) {
    if (isReason(e, "unknown_session")) return undefined;
    throw e;
  }
  return answer["closed"] === false ? { id, at: iso(clock), answer: JSON.stringify(answer) } : undefined;
};

const orphansOf = async (call: HostCall, lead: LeadState): Promise<string[]> => {
  const listed = (await call(["list"]))["sessions"];
  const known = new Set([lead.sessionId, ...lead.retired]);
  return (Array.isArray(listed) ? listed.map(rec) : [])
    .filter((row) => row["name"] === leadName(lead.bot))
    .map((row) => str(row["durableSessionId"]))
    .filter((id): id is string => id !== undefined && !known.has(id));
};

/**
 * switching (the pump holds every call) -> close the old id -> open the new one -> active with generation + 1 and the
 * old id retired. The old id goes into `retired` as soon as its close answered, while the lead is still `switching`
 * (the pump makes no call then), so a run cut off later and run again neither closes it twice nor asks it for its
 * model (pass --model then), and lists the sessions an earlier cut-off run opened. The pump sees the higher generation
 * and replays what the old lead got in its last 10 minutes.
 */
export const replaceLead = async (d: LeadSessionDeps, input: ReplaceInput): Promise<ReplaceResult> => {
  const lead = await readLeadState(d.stateDir, input.bot);
  if (lead === null) throw new LeadSessionError(`no lead/${input.bot}.json; use dori lead open`, 3);
  if (lead.runtime !== "omo-host")
    throw new LeadSessionError(`dori lead replace handles omo-host leads; this lead runs on ${lead.runtime}`, 3);
  const rulesFile = absoluteFile("rules", input.rulesFile);
  const oldEngine = lead.engine ?? "omo";
  const engine = input.engine ?? lead.openingEngine ?? oldEngine;
  const oldCall = hostCaller(d.exec, oldEngine);
  const old = lead.sessionId;
  const closed = lead.retired.includes(old);
  const model = input.model ?? (closed ? undefined : await modelOf(oldCall, old));
  if (model === undefined)
    throw new LeadSessionError(
      closed
        ? "a replace was cut off after its close; run it again with --model"
        : `${old} reports no model; pass --model`,
      2,
    );
  const orphans =
    lead.state === "switching" ? await orphansOf(hostCaller(d.exec, lead.openingEngine ?? oldEngine), lead) : [];
  const { openingEngine: _opening, ...previous } = lead;
  let switching: LeadState = { ...previous, state: "switching", openingEngine: engine };
  writeLeadState(d.stateDir, switching);
  const closeFailure = closed ? undefined : await closeOld(oldCall, d.clock, old);
  if (!closed) {
    const failures = closeFailure === undefined ? {} : { closeFailures: [...(lead.closeFailures ?? []), closeFailure] };
    switching = { ...switching, retired: [...lead.retired, old], ...failures };
    writeLeadState(d.stateDir, switching);
  }
  if (closeFailure !== undefined)
    await d.alert(
      `dori lead replace (${input.bot}): the host refused to close the old lead ${old} (${closeFailure.answer}); it may still run, and Dori no longer calls it.`,
    );
  const sessionId = await openHostSession(hostCaller(d.exec, engine), {
    bot: input.bot,
    cwd: lead.cwd,
    model,
    rulesFile,
  });
  const { openingEngine: _target, ...retired } = switching;
  const next: LeadState = {
    ...retired,
    engine,
    state: "active",
    sessionId,
    generation: lead.generation + 1,
    rules: "first-prompt",
    rulesFile,
  };
  writeLeadState(d.stateDir, next);
  return { lead: next, retired: old, ...(closeFailure === undefined ? {} : { closeFailure }), orphans };
};

export const leadStatus = async (stateDir: string, bot: string): Promise<LeadState> => {
  const lead = await readLeadState(stateDir, bot);
  if (lead === null) throw new LeadSessionError(`no lead/${bot}.json`, 3);
  return lead;
};
