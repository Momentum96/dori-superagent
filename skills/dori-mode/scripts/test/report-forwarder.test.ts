import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type Lane, Registry } from "../src/registry.ts";
import { defaultConfig } from "../src/config.ts";
import { type ForwarderDeps, forwarderDeps, forwardTick } from "../src/report-forwarder.ts";
import { Reports } from "../src/reports.ts";
import type { Ran, Runner } from "../src/run.ts";
import { fakeClock, withState } from "./fakes.ts";

const T0 = Date.parse("2026-11-21T02:00:00.000Z");
let state: ReturnType<typeof withState>;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

type Envelope = { readonly id: string; readonly kind: string; readonly source: string; readonly body: string };
/** A lead inbox behind an argv: rows keyed by id (a repeated id is ignored, as the store does), and every call kept. */
type Inbox = { readonly rows: Map<string, Envelope>; readonly calls: Envelope[]; answer: (e: Envelope) => Ran };

const inbox = (): Inbox => ({ rows: new Map(), calls: [], answer: () => ({ code: 0, out: "inserted", err: "" }) });
const runnerFor =
  (box: Inbox): Runner =>
  async (_argv, opts) => {
    const e = JSON.parse(opts?.stdin ?? "") as Envelope;
    box.calls.push(e);
    return box.answer(e);
  };
const store = (box: Inbox) => (e: Envelope) => {
  if (!box.rows.has(e.id)) box.rows.set(e.id, e);
};

const lane = (key: string, patch: Partial<Lane> = {}): Lane => ({
  key,
  title: key,
  thread: `thread-${key}`,
  brief: "/tmp/brief.md",
  done: "closed acme/app#3",
  openedAt: new Date(T0).toISOString(),
  reportProtocol: "jsonl-v1",
  ...patch,
});
const deps = (box: Inbox): ForwarderDeps => ({
  run: runnerFor(box),
  registry: new Registry(state.dir),
  stateDir: state.dir,
  machine: "omarchy",
  inboxArgv: ["ssh", "macmini", "dori-inbox-drop", "omo"],
});
const journal = (key: string) => join(state.dir, "lanes", key, "reports.jsonl");
const cursors = () => join(state.dir, "forwarder", "cursors.json");
const offsets = (key: string): number[] => {
  const out: number[] = [];
  let at = 0;
  for (const line of readFileSync(journal(key), "utf8").split("\n").slice(0, -1)) {
    out.push(at);
    at += Buffer.byteLength(line) + 1;
  }
  return out;
};
const accept = (box: Inbox) => {
  const put = store(box);
  box.answer = (e) => {
    put(e);
    return { code: 0, out: "inserted", err: "" };
  };
};

test("milestone, blocker, done: two envelopes with ids ending in their byte offsets, then nothing new", async () => {
  // Given a launched lane whose journal holds a milestone, a blocker and a done report
  await new Registry(state.dir).write(lane("fix-x"));
  const reports = new Reports(state.dir);
  reports.report("fix-x", "milestone", "tests green", T0);
  reports.report("fix-x", "blocker", "needs the owner's token", T0 + 1);
  reports.report("fix-x", "done", "merged acme/app#3", T0 + 2);
  const box = inbox();
  accept(box);
  // When the forwarder runs twice
  await forwardTick(deps(box));
  const again = await forwardTick(deps(box));
  // Then exactly the blocker and the done line reached the inbox, once each, keyed by machine, lane and offset
  const [, blockerAt, doneAt] = offsets("fix-x");
  expect([...box.rows.keys()]).toEqual([`r:omarchy:fix-x:${blockerAt}`, `r:omarchy:fix-x:${doneAt}`]);
  expect(box.calls).toHaveLength(2);
  expect(box.rows.get(`r:omarchy:fix-x:${blockerAt}`)).toMatchObject({ kind: "blocker", source: "lane:omarchy/fix-x" });
  expect(box.rows.get(`r:omarchy:fix-x:${doneAt}`)?.body).toContain("[REPORT] fix-x | done | merged acme/app#3");
  expect(box.rows.get(`r:omarchy:fix-x:${doneAt}`)?.body).toContain("thread thread-fix-x");
  expect(again).toEqual([]);
  expect(JSON.parse(readFileSync(cursors(), "utf8"))).toEqual({ "fix-x": readFileSync(journal("fix-x")).length });
});

test("T2.13 a delivery failing for ten simulated minutes holds the cursor, then every line arrives exactly once", async () => {
  // Given a lane with three forwardable lines and an inbox hop that fails until ten minutes have passed
  await new Registry(state.dir).write(lane("fix-x"));
  const reports = new Reports(state.dir);
  reports.report("fix-x", "question", "which tenant?", T0);
  reports.report("fix-x", "blocker", "token expired", T0);
  reports.append({ type: "activity", key: "fix-x", at: new Date(T0).toISOString(), state: "stalled", text: "idle" });
  const clock = fakeClock(T0);
  const box = inbox();
  const put = store(box);
  box.answer = (e) => {
    // Alternate a real ssh failure with the Tailscale-masked one (exit 0, no acknowledgement on stdout)
    if (clock.now() < T0 + 10 * 60_000)
      return (clock.now() - T0) % 30_000 === 0
        ? { code: 255, out: "", err: "ssh: connect timed out" }
        : { code: 0, out: "", err: "dori-inbox-drop: No such file or directory" };
    put(e);
    return { code: 0, out: "inserted", err: "" };
  };
  // When the forwarder ticks every 15 s through the outage and past it
  for (; clock.at <= T0 + 10 * 60_000; clock.at += 15_000) {
    const acts = await forwardTick(deps(box));
    if (clock.at < T0 + 10 * 60_000) {
      expect(acts.map((a) => a.kind)).toEqual(["failed"]);
      expect(existsSync(cursors())).toBe(false);
    }
  }
  await forwardTick(deps(box));
  // Then the inbox holds one row per journal line, in journal order, and the outage resent only the first line
  expect([...box.rows.values()].map((e) => e.kind)).toEqual(["question", "blocker", "stalled"]);
  expect(new Set(box.calls.map((e) => e.id)).size).toBe(3);
  expect(box.calls.filter((e) => e.kind !== "question")).toHaveLength(2);
});

test("a delivery that timed out after the far side stored it is resent with the same id and stays one row", async () => {
  await new Registry(state.dir).write(lane("fix-x"));
  new Reports(state.dir).report("fix-x", "done", "merged", T0);
  const box = inbox();
  const put = store(box);
  let first = true;
  box.answer = (e) => {
    put(e);
    if (first) {
      first = false;
      return { code: 124, out: "", err: "killed by SIGKILL (timeout)" };
    }
    return { code: 0, out: "duplicate", err: "" };
  };
  expect((await forwardTick(deps(box))).map((a) => a.kind)).toEqual(["failed"]);
  expect((await forwardTick(deps(box))).map((a) => a.kind)).toEqual(["forwarded"]);
  expect(box.calls).toHaveLength(2);
  expect(new Set(box.calls.map((e) => e.id)).size).toBe(1);
  expect(box.rows.size).toBe(1);
});

test("a partial last line waits until its newline is written", async () => {
  await new Registry(state.dir).write(lane("fix-x"));
  const reports = new Reports(state.dir);
  reports.report("fix-x", "blocker", "first", T0);
  const whole = JSON.stringify({
    type: "report",
    key: "fix-x",
    at: new Date(T0).toISOString(),
    kind: "done",
    text: "x",
  });
  appendFileSync(journal("fix-x"), whole.slice(0, 20));
  const box = inbox();
  accept(box);
  await forwardTick(deps(box));
  expect([...box.rows.values()].map((e) => e.kind)).toEqual(["blocker"]);
  appendFileSync(journal("fix-x"), `${whole.slice(20)}\n`);
  await forwardTick(deps(box));
  expect([...box.rows.values()].map((e) => e.kind)).toEqual(["blocker", "done"]);
});

test("an adopted lane, a running activity and a malformed line are not forwarded; later lines still are", async () => {
  const registry = new Registry(state.dir);
  await registry.write(lane("adopted", { reportProtocol: undefined }));
  await registry.write(lane("fix-x"));
  const reports = new Reports(state.dir);
  reports.report("adopted", "blocker", "screen lane", T0);
  reports.append({ type: "activity", key: "fix-x", at: new Date(T0).toISOString(), state: "running", text: "busy" });
  appendFileSync(journal("fix-x"), "{not json\n");
  reports.report("fix-x", "halted", "stopped by owner", T0);
  const box = inbox();
  accept(box);
  const acts = await forwardTick(deps(box));
  expect(acts.map((a) => `${a.kind} ${a.lane}`)).toEqual(["malformed fix-x", "forwarded fix-x"]);
  expect([...box.rows.values()].map((e) => e.kind)).toEqual(["halted"]);
});

test("an unreadable cursor file starts over without a second inbox row", async () => {
  await new Registry(state.dir).write(lane("fix-x"));
  new Reports(state.dir).report("fix-x", "done", "merged", T0);
  const box = inbox();
  accept(box);
  await forwardTick(deps(box));
  writeFileSync(cursors(), "{broken");
  const acts = await forwardTick(deps(box));
  expect(acts.map((a) => a.kind)).toEqual(["rewound", "forwarded"]);
  expect(box.rows.size).toBe(1);
  expect(JSON.parse(readFileSync(cursors(), "utf8"))).toEqual({ "fix-x": readFileSync(journal("fix-x")).length });
});

test("a failing inbox argv leaves the cursor file as it was, even past a skipped milestone", async () => {
  await new Registry(state.dir).write(lane("fix-x"));
  const reports = new Reports(state.dir);
  reports.report("fix-x", "milestone", "half way", T0);
  reports.report("fix-x", "blocker", "stuck", T0);
  const box = inbox();
  box.answer = () => ({ code: 1, out: "", err: "" });
  expect((await forwardTick(deps(box))).map((a) => a.kind)).toEqual(["failed"]);
  expect(existsSync(cursors())).toBe(false);
  expect(box.rows.size).toBe(0);
});

test("a machine name that is not a lowercase word is refused before anything is sent", () => {
  const config = { ...defaultConfig("/home/ana"), stateDir: state.dir };
  const reg = new Registry(state.dir);
  const box = inbox();
  expect(() => forwarderDeps({ ...config, machine: "MacBook Pro" }, runnerFor(box), reg)).toThrow(/invalid machine/);
  expect(forwarderDeps({ ...config, machine: "omarchy" }, runnerFor(box), reg).machine).toBe("omarchy");
});

test("exit 0 without an acknowledgement (Tailscale SSH masks the remote status) is a failure: no row, no cursor", async () => {
  await new Registry(state.dir).write(lane("fix-x"));
  new Reports(state.dir).report("fix-x", "blocker", "stuck", T0);
  const box = inbox();
  box.answer = () => ({ code: 0, out: "", err: "rejected: bad id" });
  const acts = await forwardTick(deps(box));
  expect(acts.map((a) => a.kind)).toEqual(["failed"]);
  expect(acts[0]?.detail).toContain("rejected: bad id");
  expect(existsSync(cursors())).toBe(false);
  expect(box.rows.size).toBe(0);
});

test("exit 0 with spooled as the last stdout line is a delivery", async () => {
  await new Registry(state.dir).write(lane("fix-x"));
  new Reports(state.dir).report("fix-x", "done", "merged", T0);
  const box = inbox();
  const put = store(box);
  box.answer = (e) => {
    put(e);
    return { code: 0, out: "spooled\n", err: "" };
  };
  expect((await forwardTick(deps(box))).map((a) => a.kind)).toEqual(["forwarded"]);
  expect(box.rows.size).toBe(1);
  expect(JSON.parse(readFileSync(cursors(), "utf8"))).toEqual({ "fix-x": readFileSync(journal("fix-x")).length });
});
