/**
 * The lead pump: the one standing process that calls the lead session. Each tick it reads lead/<bot>.json, takes the
 * next inbox batch and delivers it with the lead runtime's own `deliver` (prompt when idle, steer when working). It
 * calls no session but the active lead id, makes no call while the lead is switching, and never aborts a stuck lead.
 */
import { type DeliverOutcome, parseRef, type Probe, type SessionRef } from "../../../../src/runtime/types.ts";
import type { LeadItem } from "./lead-inbox.ts";
import { pumpHealth, readSeed, type Watch, writeHealth } from "./lead-pump-health.ts";
import { type PumpDeps, runAcceptedHook, SysItems } from "./lead-pump-sys.ts";
import { renderBatch, TEXT_CAP, transcriptTokens, unreachable, WAKE } from "./lead-pump-text.ts";
import { type LeadState, LeadStateError, readLeadState } from "./lead-state.ts";

const BATCH_ITEMS = 20;
const HEALTH_MS = 30_000;
const BACKOFF_S = [5, 15, 30, 60] as const;

/** lead.json names a retired session as the active one: refused before anything is sent. */
export class RetiredLeadError extends Error {}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const seqsOf = (items: readonly LeadItem[]): number[] => items.map((i) => i.seq);

export class LeadPump {
  private lead: LeadState | null = null;
  private retryAt = 0;
  private failures = 0;
  private healthAt = Number.NEGATIVE_INFINITY;
  private readonly sys: SysItems;
  private readonly givenUp = new Set<number>();
  private readonly watch: Watch = {
    steered: new Map(),
    pendingQuestion: false,
    lastError: null,
    lastDeliveredAt: null,
  };

  constructor(private readonly d: PumpDeps) {
    const seed = readSeed(d.stateDir, d.bot);
    this.sys = new SysItems(d, seed);
    this.watch.lastDeliveredAt = seed.lastDeliveredAt ?? null;
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
    const input = { ...this.d, now, lead: this.lead, ref, runtime, host: this.sys.hostNow, watch: this.watch };
    writeHealth(this.d.stateDir, this.d.bot, await pumpHealth({ ...input, seen: this.seen }));
  }

  private async step(): Promise<boolean> {
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
    if (this.d.clock.now() < this.retryAt) return false;
    if (this.sys.noteGeneration(lead)) this.watch.steered.clear();
    if (ref.runtime === "omo-host" && !(await this.sys.hostReady(lead)))
      return this.backoff("host_unavailable: omo host status is not ready");
    try {
      await this.sys.rulesDue(lead, ref);
    } catch (e) {
      return this.failed(e);
    }
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

  private readonly seen = (ref: SessionRef, ids: readonly string[]): Promise<Set<string>> =>
    transcriptTokens(ref.runtime === "omo-host", ids, {
      screen: () => this.d.runtimes.for(ref).read(ref, 400),
      transcript: (opts) => this.d.transcript(ref.id, opts),
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

  /**
   * Taken and marked sent in one transaction (an edit lands wholly before or after), then probed: a gone session or a
   * pending dialog (its answer cannot come through the host CLI, spike S1 check g) puts the batch back unsent.
   */
  private async deliverBatch(lead: LeadState, ref: SessionRef): Promise<boolean> {
    const { inbox } = this.d;
    const taken = inbox.take(BATCH_ITEMS, TEXT_CAP, lead.generation);
    if (taken.length === 0) return true;
    const { text, items } = renderBatch(taken, { bot: this.d.bot, generation: lead.generation });
    inbox.release(seqsOf(taken.slice(items.length)));
    const rt = this.d.runtimes.for(ref);
    let probe: Probe;
    try {
      probe = await rt.probe(ref);
    } catch (e) {
      inbox.release(seqsOf(items));
      return this.failed(e);
    }
    this.watch.pendingQuestion = probe.waitingOnHuman === true;
    if (probe.status === "gone" || this.watch.pendingQuestion) {
      inbox.release(seqsOf(items));
      return probe.status !== "gone" || this.fail(`lead session ${ref.id} is unknown to its ${ref.runtime} runtime`);
    }
    inbox.attempted(seqsOf(items));
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
        this.d.inbox.release(seqsOf(items), true);
        return out.status === "working" || this.fail(`lead session ${ref.id} not ready (${out.status})`);
      case "no-agent":
        this.d.inbox.release(seqsOf(items), true);
        return this.fail(`lead session ${ref.id} is gone`);
      case "typed":
        this.d.inbox.mark(seqsOf(items), "ambiguous");
        return this.fail(`text typed into lead ${ref.id} but not submitted`);
      case "ambiguous": {
        if (/\bhost_unavailable\b/.test(out.detail)) {
          this.d.inbox.release(seqsOf(items), true);
          return this.backoff(out.detail);
        }
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

  /**
   * Done and accepted (a steered item is watched for its token); hooks.inboxAccepted runs once per item. A delivery
   * clears the last error, so health shows only errors since the last item that got through.
   */
  private async accept(items: readonly LeadItem[], steered = false): Promise<void> {
    if (items.length === 0) return;
    this.d.inbox.accept(seqsOf(items));
    for (const i of steered ? items : []) this.watch.steered.set(i.seq, { id: i.id, at: this.d.clock.now() });
    this.watch.lastDeliveredAt = new Date(this.d.clock.now()).toISOString();
    this.watch.lastError = null;
    if (this.d.hookArgv === undefined) return;
    for (const why of await runAcceptedHook(this.d.run, this.d.hookArgv, items)) this.fail(why);
  }
}
