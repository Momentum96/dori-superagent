/**
 * <stateDir>/health/<bot>.json, written by the lead pump every 30 s through a temp file and rename, for the watchdog
 * on another machine. Read back once at pump start, so a host restart or lead switch that happened while the pump was
 * down is still noticed against what the last pump saw.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { SessionRef, SessionRuntime } from "../../../../src/runtime/types.ts";
import type { LeadInbox } from "./lead-inbox.ts";
import type { HostStatus } from "./lead-pump-text.ts";
import type { LeadState } from "./lead-state.ts";

const STUCK_MS = 4 * 60_000;

export type Health = {
  readonly at: string;
  readonly bootTime: string;
  /** null for a lead outside omo's engine host (hc). pid and startedAt name the host last seen ready, also while it is not. */
  readonly host: HostStatus | null;
  readonly lead: {
    readonly generation: number;
    readonly sessionId: string;
    /** From `list` only (`state` would wake or revive the session): running, idle, absent, or unknown. */
    readonly activity: "running" | "idle" | "absent" | "unknown";
    readonly pendingQuestion: boolean;
    readonly stuck: boolean;
  } | null;
  readonly inbox: {
    readonly queued: number;
    readonly oldestQueuedSec: number;
    readonly lastDeliveredAt: string | null;
    readonly lastError: string | null;
  };
};

const pathOf = (stateDir: string, bot: string): string => join(stateDir, "health", `${bot}.json`);

export const writeHealth = (stateDir: string, bot: string, health: Health): void => {
  const path = pathOf(stateDir, bot);
  mkdirSync(join(stateDir, "health"), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(health)}\n`, { flush: true });
  renameSync(tmp, path);
};

export type Watch = {
  /** Items delivered by steer, by seq: their token must show in the transcript within 4 minutes. */
  readonly steered: Map<number, { readonly id: string; readonly at: number }>;
  pendingQuestion: boolean;
  lastError: string | null;
  lastDeliveredAt: string | null;
};

export type HealthInput = {
  readonly now: number;
  readonly bootTime: string;
  readonly inbox: LeadInbox;
  readonly lead: LeadState | null;
  readonly ref: SessionRef | undefined;
  readonly runtime: SessionRuntime | undefined;
  readonly host: HostStatus | null;
  readonly watch: Watch;
  readonly seen: (ref: SessionRef, ids: readonly string[]) => Promise<Set<string> | undefined>;
};

const activityOf = async (h: HealthInput): Promise<NonNullable<Health["lead"]>["activity"]> => {
  if (h.ref === undefined || h.runtime === undefined || h.lead?.state !== "active") return "unknown";
  try {
    const row = (await h.runtime.list()).find((s) => s.ref.id === h.ref?.id);
    return row === undefined ? "absent" : row.status === "working" ? "running" : "idle";
  } catch {
    return "unknown";
  }
};

/** A steered item still without its token 4 minutes on; never checked while the lead is switching (no session call). */
const steerStuck = async (h: HealthInput): Promise<boolean> => {
  const overdue = [...h.watch.steered].filter(([, s]) => h.now - s.at >= STUCK_MS);
  if (overdue.length === 0 || h.ref === undefined || h.lead?.state !== "active") return false;
  try {
    const found = await h.seen(
      h.ref,
      overdue.map(([, s]) => s.id),
    );
    for (const [seq, s] of overdue) if (found?.has(s.id)) h.watch.steered.delete(seq);
    return overdue.some(([, s]) => !found?.has(s.id));
  } catch (e) {
    h.watch.lastError = `stuck check: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300);
    return true;
  }
};

export const pumpHealth = async (h: HealthInput): Promise<Health> => {
  const stats = h.inbox.stats();
  const oldest = stats.oldestQueuedAt === null ? h.now : Date.parse(stats.oldestQueuedAt);
  const oldestQueuedSec = Math.max(0, Math.floor((h.now - oldest) / 1000));
  const lead =
    h.lead === null
      ? null
      : {
          generation: h.lead.generation,
          sessionId: h.lead.sessionId,
          activity: await activityOf(h),
          pendingQuestion: h.watch.pendingQuestion,
          stuck: (await steerStuck(h)) || oldestQueuedSec * 1000 > STUCK_MS,
        };
  return {
    at: new Date(h.now).toISOString(),
    bootTime: h.bootTime,
    host: h.ref?.runtime === "omo-host" ? h.host : null,
    lead,
    inbox: {
      queued: stats.queued,
      oldestQueuedSec,
      lastDeliveredAt: h.watch.lastDeliveredAt,
      lastError: h.watch.lastError,
    },
  };
};

export type Seed = {
  readonly at?: number;
  readonly host?: { readonly pid: number | null; readonly startedAt: string | null };
  readonly generation?: number;
  readonly lastDeliveredAt?: string;
};

/** What the last pump wrote, field by field: a missing or damaged file seeds nothing. */
export const readSeed = (stateDir: string, bot: string): Seed => {
  let o: Partial<Record<keyof Health, unknown>>;
  try {
    o = JSON.parse(readFileSync(pathOf(stateDir, bot), "utf8")) as typeof o;
  } catch {
    return {};
  }
  const host = o.host as Partial<HostStatus> | null | undefined;
  const lead = o.lead as { generation?: unknown } | null | undefined;
  const last = (o.inbox as { lastDeliveredAt?: unknown } | undefined)?.lastDeliveredAt;
  const at = typeof o.at === "string" ? Date.parse(o.at) : Number.NaN;
  return {
    ...(Number.isNaN(at) ? {} : { at }),
    ...(typeof host?.pid === "number" ? { host: { pid: host.pid, startedAt: host.startedAt ?? null } } : {}),
    ...(typeof lead?.generation === "number" ? { generation: lead.generation } : {}),
    ...(typeof last === "string" ? { lastDeliveredAt: last } : {}),
  };
};
