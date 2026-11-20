import { expect, test } from "bun:test";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { LeadInboxError, parseEnvelope } from "../src/lead-envelope.ts";
import { LeadInbox, leadInboxPath } from "../src/lead-inbox.ts";
import { type LeadState, LeadStateError, readLeadState, writeLeadState } from "../src/lead-state.ts";
import { type Clock, run } from "../src/run.ts";
import { withState } from "./fakes.ts";

const fixedClock = (start = Date.parse("2026-11-21T00:00:00Z")): Clock & { t: number } => {
  const clock = {
    t: start,
    now: () => clock.t,
    sleep: async (ms: number) => {
      clock.t += ms;
    },
  };
  return clock;
};

const ev = (id: string, body = `body of ${id}`) => ({ id, kind: "event", source: "test", body });

const inState = async (fn: (dir: string) => Promise<void> | void) => {
  const state = withState();
  try {
    await fn(state.dir);
  } finally {
    state.done();
  }
};

test("a second put of the same id is a duplicate and leaves the first row as it was", () =>
  inState((dir) => {
    const inbox = new LeadInbox(dir, "omo", fixedClock());
    expect(inbox.put(ev("discord:1", "first"))).toBe("inserted");
    expect(inbox.put(ev("discord:1", "second"))).toBe("duplicate");
    inbox.mark([1], "done");
    expect(inbox.put(ev("discord:1", "third"))).toBe("duplicate");
    expect(inbox.list().map((i) => [i.seq, i.body, i.state])).toEqual([[1, "first", "done"]]);
    inbox.close();
  }));

test("nextBatch takes queued items in seq order within maxItems and maxBytes, the first one always", () =>
  inState((dir) => {
    const inbox = new LeadInbox(dir, "omo", fixedClock());
    for (const id of ["z:3", "a:1", "m:2", "b:4"]) inbox.put(ev(id, "x".repeat(10)));
    expect(inbox.nextBatch(10, 1_000).map((i) => i.id)).toEqual(["z:3", "a:1", "m:2", "b:4"]);
    expect(inbox.nextBatch(2, 1_000).map((i) => i.id)).toEqual(["z:3", "a:1"]);
    expect(inbox.nextBatch(10, 25).map((i) => i.id)).toEqual(["z:3", "a:1"]);
    expect(inbox.nextBatch(10, 1).map((i) => i.id)).toEqual(["z:3"]);
    inbox.mark([1, 3], "sent");
    expect(inbox.nextBatch(10, 1_000).map((i) => i.seq)).toEqual([2, 4]);
    inbox.close();
  }));

test(
  "two processes putting 200 distinct ids each at once leave 400 rows and no error",
  () =>
    inState(async (dir) => {
      const module = join(import.meta.dir, "../src/lead-inbox.ts");
      const writer = (prefix: string) =>
        run(
          [
            process.execPath,
            "-e",
            `const { LeadInbox } = await import(${JSON.stringify(module)});
           const inbox = new LeadInbox(${JSON.stringify(dir)}, "omo", { now: () => Date.now(), sleep: async () => {} });
           for (let i = 0; i < 200; i++) if (inbox.put({ id: "${prefix}:" + i, kind: "event", source: "t", body: "b" }) !== "inserted") process.exit(3);
           inbox.close();`,
          ],
          { timeoutMs: 60_000 },
        );
      const results = await Promise.all([writer("a"), writer("b")]);
      expect(results.map((r) => [r.code, r.err])).toEqual([
        [0, ""],
        [0, ""],
      ]);
      const inbox = new LeadInbox(dir, "omo", fixedClock());
      expect(inbox.stats()).toMatchObject({ queued: 400, total: 400 });
      expect(new Set(inbox.list().map((i) => i.seq)).size).toBe(400);
      inbox.close();
    }),
  90_000,
);

test("replaceBody works while queued and is refused once the item was sent; sent stamps time and attempts", () =>
  inState((dir) => {
    const clock = fixedClock();
    const inbox = new LeadInbox(dir, "omo", clock);
    inbox.put(ev("discord:9", "before"));
    expect(inbox.replaceBody("discord:9", "edited")).toBe(true);
    clock.t += 5_000;
    expect(inbox.mark([1], "sent")).toBe(1);
    expect(inbox.replaceBody("discord:9", "too late")).toBe(false);
    expect(inbox.replaceBody("discord:missing", "x")).toBe(false);
    expect(inbox.list("sent").map((i) => [i.body, i.sentAt, i.attempts, i.createdAt])).toEqual([
      ["edited", "2026-11-21T00:00:05.000Z", 1, "2026-11-21T00:00:00.000Z"],
    ]);
    expect(inbox.stats()).toEqual({ queued: 0, sent: 1, ambiguous: 0, done: 0, total: 1, oldestQueuedAt: null });
    inbox.close();
  }));

test("malformed envelopes and bot names are refused before anything is written", () =>
  inState((dir) => {
    const bad: unknown[] = [
      ev("bad id"),
      ev("Discord:1"),
      ev("discord:"),
      ev("discord"),
      ev(`d:${"x".repeat(201)}`),
      ev("d:1/../2"),
      { ...ev("d:1"), kind: "" },
      { ...ev("d:1"), source: 3 },
      { ...ev("d:1"), body: null },
      { ...ev("d:1"), channel: "" },
      ["d:1"],
      null,
      "d:1",
    ];
    for (const raw of bad) expect(() => parseEnvelope(raw)).toThrow(LeadInboxError);
    expect(parseEnvelope({ ...ev("d:1"), channel: "c1", message: "m1" })).toMatchObject({
      channel: "c1",
      message: "m1",
    });
    for (const bot of ["../x", "Omo", "", "a/b"]) expect(() => leadInboxPath(dir, bot)).toThrow(LeadInboxError);
    const inbox = new LeadInbox(dir, "omo", fixedClock());
    expect(() => inbox.put(ev("bad id"))).toThrow(LeadInboxError);
    expect(inbox.stats().total).toBe(0);
    inbox.close();
  }));

test("a file that is not an inbox database fails loudly instead of being replaced", () =>
  inState((dir) => {
    mkdirSync(join(dir, "lead-inbox"), { recursive: true });
    writeFileSync(leadInboxPath(dir, "omo"), "this is not sqlite, a torn copy or a wrong file");
    expect(() => new LeadInbox(dir, "omo", fixedClock())).toThrow();
  }));

const lead: LeadState = {
  bot: "omo",
  runtime: "omo-host",
  generation: 3,
  sessionId: "s-1",
  state: "active",
  retired: ["s-0"],
  cwd: "/Volumes/Work/dori",
};

test("lead state round-trips, refuses an unknown state, and reports a corrupt file instead of guessing", () =>
  inState(async (dir) => {
    expect(await readLeadState(dir, "omo")).toBeNull();
    writeLeadState(dir, lead);
    expect(await readLeadState(dir, "omo")).toEqual(lead);
    expect(readdirSync(join(dir, "lead"))).toEqual(["omo.json"]);
    const unknown = { ...lead, state: "paused" } as unknown as LeadState;
    expect(() => writeLeadState(dir, unknown)).toThrow(LeadStateError);
    expect(await readLeadState(dir, "omo")).toEqual(lead);
    for (const broken of [
      { ...lead, state: "paused" },
      { ...lead, generation: 1.5 },
      { ...lead, retired: "s-0" },
      { ...lead, sessionId: "" },
      { ...lead, bot: "omp" },
    ]) {
      writeFileSync(join(dir, "lead", "omo.json"), JSON.stringify(broken));
      await expect(readLeadState(dir, "omo")).rejects.toThrow(LeadStateError);
    }
    writeFileSync(join(dir, "lead", "omo.json"), '{"bot":"omo","runti');
    await expect(readLeadState(dir, "omo")).rejects.toThrow(LeadStateError);
    writeLeadState(dir, { ...lead, generation: 4, state: "switching" });
    writeFileSync(join(dir, "lead", "omo.json.99999.tmp"), "{half");
    expect(await readLeadState(dir, "omo")).toMatchObject({ generation: 4, state: "switching" });
  }));
