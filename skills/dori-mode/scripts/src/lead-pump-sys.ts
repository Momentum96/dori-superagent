/**
 * The items the lead pump puts into its own inbox: a lead replaced (with the replay of what the old lead got in its
 * last 10 minutes), the engine host restarted, and a rules refresh for a lead whose rules came in its first prompt.
 */
import { type ArgvTemplate, fill } from "./config.ts";
import type { LeadInbox, LeadItem } from "./lead-inbox.ts";
import { type HostStatus, idPart } from "./lead-pump-text.ts";
import type { LeadState } from "./lead-state.ts";
import type { Runner } from "./run.ts";

const SYS = { kind: "sys", source: "lead-pump" } as const;
const REPLAY_MS = 10 * 60_000;
const REFRESH_HOUR = 4;

export const leadReplaced = (inbox: LeadInbox, lead: LeadState, now: number): void => {
  const n = inbox.requeueOlder(lead.generation, new Date(now - REPLAY_MS).toISOString());
  inbox.put({
    id: `sys:lead-replaced:${lead.generation}`,
    ...SYS,
    body: `The lead was replaced (generation ${lead.generation}). ${n} item(s) the previous lead got in its last 10 minutes follow with replayed=true: read their thread before acting on them.`,
  });
};

export const rulesRefresh = (inbox: LeadInbox, lead: LeadState, tag: string): void => {
  inbox.put({
    id: `sys:rules-refresh:${tag}`,
    ...SYS,
    body: `Re-read your rules file ${lead.rulesFile ?? "(lead.json names no rulesFile)"} now and follow it: rules given in a first prompt do not survive compaction.`,
  });
};

export const hostRestarted = (inbox: LeadInbox, lead: LeadState, s: HostStatus): void => {
  const tag = idPart(s.startedAt ?? `pid-${String(s.pid)}`);
  inbox.put({
    id: `sys:host-restart:${tag}`,
    ...SYS,
    body: `omo's engine host restarted (pid ${String(s.pid)}, started ${String(s.startedAt)}); your session id is unchanged. Check open lanes and replies you owe.`,
  });
  if (lead.rules === "first-prompt") rulesRefresh(inbox, lead, tag);
};

/**
 * The local date (YYYY-MM-DD) of the first 04:00 after `checkedAt` when it is not later than `now`, else undefined.
 * `checkedAt` starts at the last pump's health stamp, so a pump that was down at 04:00 still sends that day's refresh.
 */
export const refreshDue = (checkedAt: number, now: number): string | undefined => {
  const next = new Date(checkedAt);
  next.setHours(REFRESH_HOUR, 0, 0, 0);
  if (next.getTime() <= checkedAt) next.setDate(next.getDate() + 1);
  if (next.getTime() > now) return undefined;
  return [next.getFullYear(), next.getMonth() + 1, next.getDate()].map((n) => String(n).padStart(2, "0")).join("-");
};

/** hooks.inboxAccepted once per accepted item (the Discord eyes reaction); {channel} and {message} are empty off Discord. */
export const runAcceptedHook = async (
  run: Runner,
  template: ArgvTemplate,
  items: readonly LeadItem[],
): Promise<string[]> => {
  const failures: string[] = [];
  for (const i of items) {
    const values = { id: i.id, kind: i.kind, source: i.source, channel: i.channel ?? "", message: i.message ?? "" };
    const r = await run(fill(template, values));
    if (r.code !== 0) failures.push(`hooks.inboxAccepted failed for ${i.id} (${r.code}): ${r.err}`);
  }
  return failures;
};
