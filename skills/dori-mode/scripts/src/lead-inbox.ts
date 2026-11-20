/**
 * The lead inbox: one SQLite file per bot at <stateDir>/lead-inbox/<bot>.sqlite. Many writers (the Discord watcher,
 * the report forwarder, the spool import, the pump itself) put items; one reader, the pump, takes them in seq order.
 * SQLite rather than a jsonl journal (reports.ts) because several writers need id uniqueness and crash-safe order.
 * Not the pane message queue in src/inbox*.ts.
 */
import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { type Envelope, LeadInboxError, parseBot, parseEnvelope } from "./lead-envelope.ts";
import { openInboxDb } from "./lead-inbox-db.ts";
import { type Clock, iso } from "./run.ts";

export type LeadItemState = "queued" | "sent" | "ambiguous" | "done";
export type PutOutcome = "inserted" | "duplicate" | "replaced";
export type LeadItem = Envelope & {
  readonly seq: number;
  readonly state: LeadItemState;
  readonly generation: number | null;
  readonly createdAt: string;
  readonly sentAt: string | null;
  readonly attempts: number;
  readonly accepted: number;
};
export type LeadInboxStats = Readonly<Record<LeadItemState, number>> & {
  readonly total: number;
  readonly oldestQueuedAt: string | null;
};

const STATES: readonly LeadItemState[] = ["queued", "sent", "ambiguous", "done"];

export const isLeadItemState = (value: unknown): value is LeadItemState => STATES.some((s) => s === value);

type Row = {
  seq: number;
  id: string;
  kind: string;
  source: string;
  body: string;
  state: LeadItemState;
  generation: number | null;
  created_at: string;
  sent_at: string | null;
  attempts: number;
  accepted: number;
  channel: string | null;
  message: string | null;
};

const item = (r: Row): LeadItem => ({
  seq: r.seq,
  id: r.id,
  kind: r.kind,
  source: r.source,
  body: r.body,
  state: r.state,
  generation: r.generation,
  createdAt: r.created_at,
  sentAt: r.sent_at,
  attempts: r.attempts,
  accepted: r.accepted,
  ...(r.channel === null ? {} : { channel: r.channel }),
  ...(r.message === null ? {} : { message: r.message }),
});

export const leadInboxPath = (stateDir: string, bot: string): string =>
  join(stateDir, "lead-inbox", `${parseBot(bot)}.sqlite`);

export class LeadInbox {
  private readonly db: Database;

  constructor(
    stateDir: string,
    bot: string,
    private readonly clock: Clock,
  ) {
    const path = leadInboxPath(stateDir, bot);
    mkdirSync(join(stateDir, "lead-inbox"), { recursive: true });
    this.db = openInboxDb(path);
  }

  /**
   * INSERT OR IGNORE: an id already present, in any state, is a duplicate and its row is left as it was. An envelope
   * whose `replaces` names an item still queued rewrites that item's body instead and answers replaced (the lead has
   * not seen it, so it gets one item with the latest text); once that item left queued the edit is inserted as its own
   * item. One immediate transaction, so a pump moving the original to sent sees either the old or the new body.
   */
  put(envelope: Envelope): PutOutcome {
    const e = parseEnvelope(envelope);
    return this.db
      .transaction((): PutOutcome => {
        const known = this.db.query("SELECT 1 FROM items WHERE id = $id").get({ id: e.id }) !== null;
        if (!known && e.replaces !== undefined && this.replaceBody(e.replaces, e.body)) return "replaced";
        return this.insert(e);
      })
      .immediate();
  }

  private insert(e: Envelope): "inserted" | "duplicate" {
    const changes = this.db
      .query(
        `INSERT OR IGNORE INTO items(id, kind, source, body, state, created_at, channel, message)
         VALUES ($id, $kind, $source, $body, 'queued', $at, $channel, $message)`,
      )
      .run({
        id: e.id,
        kind: e.kind,
        source: e.source,
        body: e.body,
        at: iso(this.clock),
        channel: e.channel ?? null,
        message: e.message ?? null,
      }).changes;
    return changes === 1 ? "inserted" : "duplicate";
  }

  /**
   * Queued items in seq order, up to maxItems and maxBytes of body. The first item is always taken, even when its
   * body alone is over maxBytes, so one large item cannot hold the queue.
   */
  nextBatch(maxItems: number, maxBytes: number): LeadItem[] {
    const rows = this.db
      .query("SELECT * FROM items WHERE state = 'queued' ORDER BY seq LIMIT $n")
      .all({ n: maxItems }) as Row[];
    const batch: LeadItem[] = [];
    let bytes = 0;
    for (const r of rows) {
      bytes += Buffer.byteLength(r.body ?? "");
      if (batch.length > 0 && bytes > maxBytes) break;
      batch.push(item(r));
    }
    return batch;
  }

  /** Move items to a state; moving to sent stamps sent_at and counts one more attempt. Returns rows changed. */
  mark(seqs: readonly number[], state: LeadItemState): number {
    if (!isLeadItemState(state)) throw new LeadInboxError(`invalid state "${String(state)}"`);
    const update = this.db.query(
      state === "sent"
        ? "UPDATE items SET state = $state, sent_at = $at, attempts = attempts + 1 WHERE seq = $seq"
        : "UPDATE items SET state = $state WHERE seq = $seq",
    );
    const at = iso(this.clock);
    return this.db.transaction(() =>
      seqs.reduce((n, seq) => n + update.run(state === "sent" ? { state, at, seq } : { state, seq }).changes, 0),
    )();
  }

  private each(sql: string, seqs: readonly number[], params: Record<string, string | number> = {}): number {
    const update = this.db.query(sql);
    return this.db.transaction(() => seqs.reduce((n, seq) => n + update.run({ ...params, seq }).changes, 0))();
  }

  /**
   * The pump's batch, taken and marked in one immediate transaction so an edit (put with replaces) lands either before
   * it, and the lead gets the new body, or after it, as its own item: `sys:` items first, then nextBatch, each moved
   * to sent for `generation` (sent_at stamped) only while still queued. The rows as read; no attempt is counted yet.
   */
  take(maxItems: number, maxBytes: number, generation: number): LeadItem[] {
    const sent = this.db.query(
      "UPDATE items SET state = 'sent', sent_at = $at, generation = $g WHERE seq = $seq AND state = 'queued'",
    );
    return this.db
      .transaction((): LeadItem[] => {
        const sys = this.list("queued").filter((i) => i.id.startsWith("sys:"));
        const rest = this.nextBatch(maxItems, maxBytes).filter((i) => !sys.some((s) => s.seq === i.seq));
        const at = iso(this.clock);
        return [...sys, ...rest]
          .slice(0, maxItems)
          .filter((i) => sent.run({ at, g: generation, seq: i.seq }).changes === 1);
      })
      .immediate();
  }

  /** The pump is about to call the lead with these items: one more attempt each. */
  attempted(seqs: readonly number[]): number {
    return this.each("UPDATE items SET attempts = attempts + 1 WHERE seq = $seq", seqs);
  }

  /** Back to queued, unsent; `counted`: the call was made but never reached the lead (busy, host down), so uncount it. */
  release(seqs: readonly number[], counted = false): number {
    const sql =
      "UPDATE items SET state = 'queued', attempts = MAX(attempts - $d, 0) WHERE seq = $seq AND state = 'sent'";
    return this.each(sql, seqs, { d: counted ? 1 : 0 });
  }

  /** The lead has the items: done and accepted. */
  accept(seqs: readonly number[]): number {
    return this.each("UPDATE items SET state = 'done', accepted = 1 WHERE seq = $seq", seqs);
  }

  /** Done items sent to a generation older than `generation` at or after `since`: queued again for the new lead. */
  requeueOlder(generation: number, since: string): number {
    return this.db
      .query("UPDATE items SET state = 'queued' WHERE state = 'done' AND generation < $g AND sent_at >= $since")
      .run({ g: generation, since }).changes;
  }

  /** An edit before delivery replaces the body; once the item left queued the lead already has it, so false. */
  replaceBody(id: string, body: string): boolean {
    return (
      this.db.query("UPDATE items SET body = $body WHERE id = $id AND state = 'queued'").run({ id, body }).changes === 1
    );
  }

  list(state?: LeadItemState): LeadItem[] {
    const rows =
      state === undefined
        ? this.db.query("SELECT * FROM items ORDER BY seq").all()
        : this.db.query("SELECT * FROM items WHERE state = $state ORDER BY seq").all({ state });
    return (rows as Row[]).map(item);
  }

  stats(): LeadInboxStats {
    const counts = this.db.query("SELECT state, COUNT(*) AS n FROM items GROUP BY state").all() as {
      state: LeadItemState;
      n: number;
    }[];
    const of = (s: LeadItemState) => counts.find((c) => c.state === s)?.n ?? 0;
    const oldest = this.db.query("SELECT created_at FROM items WHERE state = 'queued' ORDER BY seq LIMIT 1").get() as {
      created_at: string;
    } | null;
    return {
      queued: of("queued"),
      sent: of("sent"),
      ambiguous: of("ambiguous"),
      done: of("done"),
      total: counts.reduce((n, c) => n + c.n, 0),
      oldestQueuedAt: oldest?.created_at ?? null,
    };
  }

  close(): void {
    this.db.close();
  }
}
