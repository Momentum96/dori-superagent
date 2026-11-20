/**
 * The items the lead pump puts into its own inbox: a lead replaced (with the replay of what the old lead got in its
 * last 10 minutes), the engine host restarted, and a rules refresh for a lead whose rules came in its first prompt
 * (after a host restart, at 04:00, and after a compaction, which drops a first-prompt rule: spike S1, check j).
 */
import type { Runtimes } from "../../../../src/runtime/registry.ts";
import type { SessionRef } from "../../../../src/runtime/types.ts";
import { type ArgvTemplate, fill } from "./config.ts";
import type { LeadInbox, LeadItem } from "./lead-inbox.ts";
import type { Seed } from "./lead-pump-health.ts";
import { type HostStatus, idPart, lastCompaction, type ReadTranscript, readTail } from "./lead-pump-text.ts";
import type { LeadState } from "./lead-state.ts";
import type { Clock, Runner } from "./run.ts";

export type PumpDeps = {
  readonly stateDir: string;
  readonly bot: string;
  readonly clock: Clock;
  readonly inbox: LeadInbox;
  readonly runtimes: Pick<Runtimes, "for">;
  /** `omo host status`, for a lead in omo's engine host. */
  readonly host: () => Promise<HostStatus>;
  /** One `read <id>` of the lead's transcript, written to a file so no pipe cuts its JSON line. */
  readonly transcript: (id: string, opts: Parameters<ReadTranscript>[0]) => Promise<string>;
  readonly run: Runner;
  readonly hookArgv?: ArgvTemplate | undefined;
  readonly bootTime: string;
};

const SYS = { kind: "sys", source: "lead-pump" } as const;
const REPLAY_MS = 10 * 60_000;
const REFRESH_HOUR = 4;
const COMPACTION_SCAN_MS = 10 * 60_000;

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
const refreshDue = (checkedAt: number, now: number): string | undefined => {
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

/** What the pump remembers between ticks to put its sys: items: the host it last saw ready, the lead generation, when it last looked for 04:00 and for a compaction. Seeded from the last pump's health file. */
export class SysItems {
  hostNow: HostStatus | null = null;
  private known: { readonly pid: number | null; readonly startedAt: string | null } | undefined;
  private generation: number | undefined;
  private refreshCheckedAt: number;
  private compactionScanAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly d: PumpDeps,
    seed: Seed,
  ) {
    this.known = seed.host;
    this.generation = seed.generation;
    this.refreshCheckedAt = seed.at ?? d.clock.now();
  }

  /** true when the lead's generation rose since the last look: the replay and sys:lead-replaced are queued. */
  noteGeneration(lead: LeadState): boolean {
    const replaced = this.generation !== undefined && lead.generation > this.generation;
    if (replaced) leadReplaced(this.d.inbox, lead, this.d.clock.now());
    this.generation = lead.generation;
    return replaced;
  }

  /** false while omo's engine host is not ready; a new pid or start time queues sys:host-restart. */
  async hostReady(lead: LeadState): Promise<boolean> {
    const s = await this.d.host();
    this.hostNow = s.ready ? s : { ...s, ...this.known };
    if (!s.ready) return false;
    const changed = this.known !== undefined && (this.known.pid !== s.pid || this.known.startedAt !== s.startedAt);
    this.known = { pid: s.pid, startedAt: s.startedAt };
    if (changed) hostRestarted(this.d.inbox, lead, s);
    return true;
  }

  /**
   * For a first-prompt lead: the 04:00 refresh, and every 10 minutes while `list` shows the lead idle, one refresh per
   * compaction entry in its transcript tail newer than the last refresh it was given. A lead without `rules` gets none.
   */
  async rulesDue(lead: LeadState, ref: SessionRef): Promise<void> {
    const now = this.d.clock.now();
    const day = refreshDue(this.refreshCheckedAt, now);
    this.refreshCheckedAt = now;
    if (lead.rules !== "first-prompt") return;
    if (day !== undefined) rulesRefresh(this.d.inbox, lead, day);
    if (ref.runtime !== "omo-host" || now - this.compactionScanAt < COMPACTION_SCAN_MS) return;
    this.compactionScanAt = now;
    const row = (await this.d.runtimes.for(ref).list()).find((s) => s.ref.id === ref.id);
    if (row?.status !== "idle") return;
    const tail = await readTail((opts) => this.d.transcript(ref.id, opts), false);
    const compaction = tail === undefined ? undefined : lastCompaction(tail);
    if (compaction === undefined) return;
    const given = this.d.inbox
      .list("done")
      .filter((i) => i.id.startsWith("sys:rules-refresh:"))
      .map((i) => i.sentAt ?? "")
      .sort()
      .at(-1);
    if (compaction.at > (given ?? "")) rulesRefresh(this.d.inbox, lead, `compaction-${idPart(compaction.id)}`);
  }
}
