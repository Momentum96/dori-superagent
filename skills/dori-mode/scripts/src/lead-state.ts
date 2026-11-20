/**
 * <stateDir>/lead/<bot>.json: which session is the bot's lead now. Only the lead switch writes it, through a temp
 * file and rename, so a reader sees the old file or the new one, never half of one.
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseBot } from "./lead-envelope.ts";

export type LeadState = {
  readonly bot: string;
  readonly runtime: string;
  readonly generation: number;
  readonly sessionId: string;
  readonly state: "active" | "switching";
  readonly retired: readonly string[];
  readonly cwd: string;
  /** How `dori lead open` gave the lead its rules; a first prompt does not survive compaction, so the pump re-sends it. */
  readonly rules?: "project-file" | "first-prompt";
  /** The rules file the lead re-reads on a `sys:rules-refresh` item. */
  readonly rulesFile?: string;
};

export class LeadStateError extends Error {}

const nonEmpty = (o: Readonly<Record<string, unknown>>, field: string): string => {
  const value = o[field];
  if (typeof value !== "string" || value === "") throw new LeadStateError(`lead state ${field} must be a string`);
  return value;
};

export const parseLeadState = (raw: unknown): LeadState => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new LeadStateError("lead state must be a JSON object");
  const o = raw as Readonly<Record<string, unknown>>;
  const state = o["state"];
  if (state !== "active" && state !== "switching")
    throw new LeadStateError(`lead state state must be active or switching, not ${JSON.stringify(state)}`);
  const generation = o["generation"];
  if (typeof generation !== "number" || !Number.isInteger(generation) || generation < 0)
    throw new LeadStateError("lead state generation must be a whole number, 0 or more");
  const retired = o["retired"];
  if (!Array.isArray(retired) || !retired.every((id): id is string => typeof id === "string" && id !== ""))
    throw new LeadStateError("lead state retired must be a list of session ids");
  const bot = nonEmpty(o, "bot");
  try {
    parseBot(bot);
  } catch (e) {
    throw new LeadStateError((e as Error).message);
  }
  const rules = o["rules"];
  if (rules !== undefined && rules !== "project-file" && rules !== "first-prompt")
    throw new LeadStateError(`lead state rules must be project-file or first-prompt, not ${JSON.stringify(rules)}`);
  return {
    bot,
    runtime: nonEmpty(o, "runtime"),
    generation,
    sessionId: nonEmpty(o, "sessionId"),
    state,
    retired,
    cwd: nonEmpty(o, "cwd"),
    ...(rules === undefined ? {} : { rules }),
    ...(o["rulesFile"] === undefined ? {} : { rulesFile: nonEmpty(o, "rulesFile") }),
  };
};

const leadStatePath = (stateDir: string, bot: string): string => join(stateDir, "lead", `${parseBot(bot)}.json`);

/** null when the bot has no lead file yet; a file that does not parse or fails the schema throws LeadStateError. */
export const readLeadState = async (stateDir: string, bot: string): Promise<LeadState | null> => {
  const file = Bun.file(leadStatePath(stateDir, bot));
  if (!(await file.exists())) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(await file.text());
  } catch {
    throw new LeadStateError(`${file.name}: not JSON`);
  }
  const state = parseLeadState(raw);
  if (state.bot !== bot) throw new LeadStateError(`${file.name}: names bot ${state.bot}`);
  return state;
};

export const writeLeadState = (stateDir: string, state: LeadState): void => {
  const checked = parseLeadState(state);
  const path = leadStatePath(stateDir, checked.bot);
  mkdirSync(join(stateDir, "lead"), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(checked, null, 1)}\n`, { flush: true });
  renameSync(tmp, path);
};
