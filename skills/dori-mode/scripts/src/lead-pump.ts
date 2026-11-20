/**
 * The lead pump: the one standing process that calls the lead session. Each tick it reads lead/<bot>.json, takes the
 * next inbox batch and delivers it with the lead runtime's own `deliver` (prompt when idle, steer when working). It
 * calls no session but the active lead id, makes no call while the lead is switching, and never aborts a stuck lead.
 */
import type { Runtimes } from "../../../../src/runtime/registry.ts";
import { type DeliverOutcome, parseRef, type Probe, type SessionRef } from "../../../../src/runtime/types.ts";
import type { ArgvTemplate } from "./config.ts";
import type { LeadInbox, LeadItem } from "./lead-inbox.ts";
import { pumpHealth, readSeed, type Watch, writeHealth } from "./lead-pump-health.ts";
import { hostRestarted, leadReplaced, refreshDue, runAcceptedHook, rulesRefresh } from "./lead-pump-sys.ts";
import { type HostStatus, renderBatch, TEXT_CAP, transcriptTokens, WAKE } from "./lead-pump-text.ts";
import { type LeadState, LeadStateError, readLeadState } from "./lead-state.ts";
import type { Clock, Runner } from "./run.ts";

const BATCH_ITEMS = 20;
const HEALTH_MS = 30_000;
const BACKOFF_S = [5, 15, 30, 60] as const;

export type PumpDeps = {
  readonly stateDir: string;
  readonly bot: string;
  readonly clock: Clock;
  readonly inbox: LeadInbox;
  readonly runtimes: Pick<Runtimes, "for">;
  /** `omo host status`, for a lead in omo's engine host. */
  readonly host: () => Promise<HostStatus>;
  /** The raw JSON answer of `read <id> --messages --tail <n>` (written to a file, so no pipe cuts it). */
  readonly transcript: (id: string, tail: number) => Promise<string>;
  readonly run: Runner;
  readonly hookArgv?: ArgvTemplate | undefined;
  readonly bootTime: string;
};

/** lead.json names a retired session as the active one: refused before anything is sent. */
export class RetiredLeadError extends Error {}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const unreachable = (text: string): boolean => /\b(host_unavailable|transport_gone)\b/.test(text);
const seqsOf = (items: readonly LeadItem[]): number[] => items.map((i) => i.seq);

export class LeadPump {
  private lead: LeadState | null = null;
  private known: { readonly pid: number | null; readonly startedAt: string | null } | undefined;
  private hostNow: HostStatus | null = null;
  private generation: number | undefined;
  private retryAt = 0;
  private failures = 0;
  private healthAt = Number.NEGATIVE_INFINITY;
  private refreshCheckedAt: number;
  private readonly givenUp = new Set<number>();
  private readonly watch: Watch = {
    steered: new Map(),
    pendingQuestion: false,
    lastError: null,
    lastDeliveredAt: null,
  };

  constructor(private readonly d: PumpDeps) {
    const seed = readSeed(d.stateDir, d.bot);
    this.known = seed.host;
    this.generation = seed.generation;
    this.watch.lastDeliveredAt = seed.lastDeliveredAt ?? null;
    this.refreshCheckedAt = seed.at ?? d.clock.now();
    d.inbox.mark(seqsOf(d.inbox.list("sent")), "ambiguous");
  }

  async tick(): Promise<void> {
    try {
      if (await this.step()) this.failures = 0;
    } finally {
      if (this.d.clock.now() - this.healthAt >= HEALTH_MS) await this.health();
    }
  }

  async health(): Promise<void> {
    const now = this.d.clock.now();
    this.healthAt = now;
    let ref: SessionRef | undefined;
    try {
      ref = this.lead === null ? undefined : this.refOf(this.lead);
    } catch (e) {
      this.fail(message(e));
    }
    const runtime = ref === undefined ? undefined : this.d.runtimes.for(ref);
    const input = { ...this.d, now, lead: this.lead, ref, runtime, host: this.hostNow, watch: this.watch };
    writeHealth(this.d.stateDir, this.d.bot, await pumpHealth({ ...input, seen: this.seen }));
  }

  private async step(): Promise<boolean> {
    const { inbox, clock } = this.d;
    this.lead = null;
    try {
      this.lead = await readLeadState(this.d.stateDir, this.d.bot);
    } catch (e) {
      if (!(e instanceof LeadStateError)) throw e;
      return this.fail(e.message);
    }
    const lead = this.lead;
    if (lead === null) return this.fail(`no lead/${this.d.bot}.json`);
    if (lead.state === "switching") return false;
    const ref = this.refOf(lead);
    if (ref === undefined) return this.fail(`lead.json names no ${lead.runtime} session: ${lead.sessionId}`);
    if (clock.now() < this.retryAt) return false;
    if (this.generation !== undefined && lead.generation > this.generation) {
      leadReplaced(inbox, lead, clock.now());
      this.watch.steered.clear();
    }
    this.generation = lead.generation;
    if (ref.runtime === "omo-host" && !(await this.checkHost(lead))) return false;
    const day = refreshDue(this.refreshCheckedAt, clock.now());
    this.refreshCheckedAt = clock.now();
    if (day !== undefined && lead.rules === "first-prompt") rulesRefresh(inbox, lead, day);
    return (await this.settleAmbiguous(ref)) && (await this.deliverBatch(lead, ref));
  }

  /** The active lead's ref; every runtime call is aimed through it, so a retired id is refused here. */
  private refOf(lead: LeadState): SessionRef | undefined {
    if (lead.retired.includes(lead.sessionId))
      throw new RetiredLeadError(`lead.json names retired session ${lead.sessionId} as active; nothing sent`);
    return parseRef(`${lead.runtime}:${lead.sessionId}`);
  }

  private fail(why: string): false {
    this.watch.lastError = why.slice(0, 300);
    return false;
  }

  /** host_unavailable or transport_gone: wait 5, 15, 30, then 60 s between tries, the queue kept as it is. */
  private backoff(why: string): false {
    this.retryAt = this.d.clock.now() + (BACKOFF_S[this.failures] ?? 60) * 1000;
    this.failures += 1;
    return this.fail(why);
  }

  private failed(e: unknown): false {
    return unreachable(message(e)) ? this.backoff(message(e)) : this.fail(message(e));
  }

  private async checkHost(lead: LeadState): Promise<boolean> {
    const s = await this.d.host();
    this.hostNow = s.ready ? s : { ...s, ...this.known };
    if (!s.ready) return this.backoff("host_unavailable: omo host status is not ready");
    const changed = this.known !== undefined && (this.known.pid !== s.pid || this.known.startedAt !== s.startedAt);
    this.known = { pid: s.pid, startedAt: s.startedAt };
    if (changed) hostRestarted(this.d.inbox, lead, s);
    return true;
  }

  private readonly seen = (ref: SessionRef, ids: readonly string[]): Promise<Set<string>> =>
    transcriptTokens(ref.runtime === "omo-host", ids, {
      screen: () => this.d.runtimes.for(ref).read(ref, 400),
      messages: (tail) => this.d.transcript(ref.id, tail),
    });

  /** Items left without a result: accepted when their token is in the transcript, else sent once more, then left. */
  private async settleAmbiguous(ref: SessionRef): Promise<boolean> {
    const rows = this.d.inbox.list("ambiguous").filter((r) => !this.givenUp.has(r.seq));
    if (rows.length === 0) return true;
    let found: Set<string>;
    try {
      found = await this.seen(
        ref,
        rows.map((r) => r.id),
      );
    } catch (e) {
      return this.failed(e);
    }
    await this.accept(rows.filter((r) => found.has(r.id)));
    for (const r of rows.filter((x) => !found.has(x.id))) {
      if (r.attempts < 2) this.d.inbox.mark([r.seq], "queued");
      else {
        this.givenUp.add(r.seq);
        this.fail(`${r.id} unconfirmed after one resend; left ambiguous`);
      }
    }
    return true;
  }

  private async deliverBatch(lead: LeadState, ref: SessionRef): Promise<boolean> {
    const { inbox } = this.d;
    const sys = inbox.list("queued").filter((i) => i.id.startsWith("sys:"));
    const rest = inbox.nextBatch(BATCH_ITEMS, TEXT_CAP).filter((i) => !sys.some((s) => s.seq === i.seq));
    const batch = [...sys, ...rest].slice(0, BATCH_ITEMS);
    if (batch.length === 0) return true;
    const rt = this.d.runtimes.for(ref);
    let probe: Probe;
    try {
      probe = await rt.probe(ref);
    } catch (e) {
      return this.failed(e);
    }
    if (probe.status === "gone") return this.fail(`lead session ${ref.id} is unknown to its ${ref.runtime} runtime`);
    this.watch.pendingQuestion = probe.waitingOnHuman === true;
    const opts = { bot: this.d.bot, generation: lead.generation, notAnAnswer: this.watch.pendingQuestion };
    const { text, items } = renderBatch(batch, opts);
    inbox.send(seqsOf(items), lead.generation);
    let out: DeliverOutcome;
    try {
      out = await rt.deliver(ref, text, { when: "any" });
    } catch (e) {
      inbox.mark(seqsOf(items), "ambiguous");
      return this.failed(e);
    }
    return this.settle(ref, items, out);
  }

  private async settle(ref: SessionRef, items: readonly LeadItem[], out: DeliverOutcome): Promise<boolean> {
    switch (out.kind) {
      case "delivered":
        await this.accept(items, out.started === false);
        return true;
      case "not-ready":
        this.d.inbox.release(seqsOf(items));
        return out.status === "working" || this.fail(`lead session ${ref.id} not ready (${out.status})`);
      case "no-agent":
        this.d.inbox.release(seqsOf(items));
        return this.fail(`lead session ${ref.id} is gone`);
      case "typed":
        this.d.inbox.mark(seqsOf(items), "ambiguous");
        return this.fail(`text typed into lead ${ref.id} but not submitted`);
      case "ambiguous": {
        if (out.failure !== "steer parked") {
          this.d.inbox.mark(seqsOf(items), "ambiguous");
          return unreachable(out.detail) ? this.backoff(out.detail) : this.fail(out.detail);
        }
        await this.accept(items, true);
        const woke = await this.d.runtimes.for(ref).deliver(ref, WAKE, { when: "idle" });
        return woke.kind === "delivered" || (woke.kind === "not-ready" && woke.status === "working")
          ? true
          : this.fail(`wake prompt to lead ${ref.id}: ${woke.kind}`);
      }
      default: {
        const never: never = out;
        return this.fail(`unknown delivery outcome ${JSON.stringify(never)}`);
      }
    }
  }

  /** Done and accepted (a steered item is watched for its token); hooks.inboxAccepted runs once per item. */
  private async accept(items: readonly LeadItem[], steered = false): Promise<void> {
    if (items.length === 0) return;
    this.d.inbox.accept(seqsOf(items));
    for (const i of steered ? items : []) this.watch.steered.set(i.seq, { id: i.id, at: this.d.clock.now() });
    this.watch.lastDeliveredAt = new Date(this.d.clock.now()).toISOString();
    if (this.d.hookArgv === undefined) return;
    for (const why of await runAcceptedHook(this.d.run, this.d.hookArgv, items)) this.fail(why);
  }
}
