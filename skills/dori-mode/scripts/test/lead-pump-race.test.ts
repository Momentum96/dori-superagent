import { afterEach, beforeEach, expect, test } from "bun:test";

import { withState } from "./fakes.ts";
import { LEAD, makeRig, type Rig, T0 } from "./lead-pump-rig.ts";

let state: ReturnType<typeof withState>;
let rig: Rig;
beforeEach(() => {
  state = withState();
  rig = makeRig(state.dir);
});
afterEach(() => {
  rig.inbox.close();
  state.done();
});

const edit = (body: string) =>
  rig.inbox.put({ id: "d:omo:1e", kind: "report", source: "lane-x", body, replaces: "d:omo:1" });

test("an edit that lands during the pump's probe never replaces what the lead got: it arrives as its own item", async () => {
  rig.put("d:omo:1", "OLD BODY");
  const answers: string[] = [];
  rig.setBefore((argv) => {
    if (answers.length === 0 && argv.includes("state")) answers.push(edit("NEW BODY"));
  });
  const pump = rig.pump();
  await pump.tick();
  rig.working(false);
  rig.clock.at += 2_000;
  await pump.tick();
  expect(answers).toEqual(["inserted"]);
  const said = [...rig.texts("prompt"), ...rig.texts("steer")].join("\n");
  for (const i of rig.inbox.list("done"))
    expect(said).toContain(`[INBOX#${i.id}] kind=report source=lane-x\n  | ${i.body}`);
  expect(rig.inbox.list("done").map((i) => [i.id, i.body])).toEqual([
    ["d:omo:1", "OLD BODY"],
    ["d:omo:1e", "NEW BODY"],
  ]);
});

test("an edit before the pump takes the item replaces it: the lead gets the new body once", async () => {
  rig.put("d:omo:1", "OLD BODY");
  expect(edit("NEW BODY")).toBe("replaced");
  await rig.pump().tick();
  expect(rig.texts("prompt")).toEqual(["[INBOX#d:omo:1] kind=report source=lane-x\n  | NEW BODY"]);
});

test("host_unavailable at the prompt twice, then the host answers: delivered exactly once, never left ambiguous", async () => {
  let refused = 0;
  rig.setBefore((argv) => {
    if (argv.includes("prompt") && refused < 2) {
      refused += 1;
      rig.host.refuseNext.set("prompt", "host_unavailable");
    }
  });
  rig.put("d:1");
  const pump = rig.pump();
  for (let n = 0; n < 12; n += 1) {
    await pump.tick();
    rig.clock.at += 61_000;
  }
  expect(rig.texts("prompt")).toHaveLength(3);
  expect(JSON.stringify(rig.host.sessions.get(LEAD)?.entries).split("[INBOX#d:1] ").length - 1).toBe(1);
  expect(rig.inbox.list().map((i) => [i.id, i.state, i.attempts])).toEqual([["d:1", "done", 1]]);
});

test("an unreadable transcript never stalls the queue: the ambiguous item is resent once, the next one delivered", async () => {
  rig.host.hangNext.set("prompt", "before");
  rig.put("d:1");
  const pump = rig.pump();
  await pump.tick();
  expect(rig.inbox.list("ambiguous").map((i) => i.id)).toEqual(["d:1"]);
  rig.setBefore((argv) => {
    if (argv.includes("read")) rig.host.hangNext.set("read", "before");
  });
  rig.put("d:2");
  for (let n = 0; n < 10; n += 1) {
    rig.clock.at += 61_000;
    await pump.tick();
  }
  expect(rig.texts("prompt")).toHaveLength(2);
  expect([rig.sends("d:1"), rig.sends("d:2")]).toEqual([2, 1]);
  expect(rig.inbox.list().map((i) => [i.id, i.state])).toEqual([
    ["d:1", "done"],
    ["d:2", "done"],
  ]);
  expect(rig.health()["lead"]).toMatchObject({ stuck: false });
});

test("a pump that died between taking a batch and calling the lead has not used up the item's one resend", async () => {
  rig.put("d:1");
  rig.inbox.take(20, 8192, 1);
  rig.host.hangNext.set("prompt", "before");
  const pump = rig.pump();
  await pump.tick();
  expect(rig.inbox.list("ambiguous").map((i) => [i.id, i.attempts])).toEqual([["d:1", 1]]);
  rig.clock.at += 2_000;
  await pump.tick();
  expect(rig.texts("prompt")).toHaveLength(2);
  expect(rig.inbox.list().map((i) => [i.id, i.state, i.attempts])).toEqual([["d:1", "done", 2]]);
});

test("a compaction in an idle first-prompt lead's transcript gives one rules refresh; a second scan adds none", async () => {
  rig.writeLead({ rules: "first-prompt", rulesFile: "/lead/RULES.md" });
  const at = new Date(T0 - 60_000).toISOString();
  rig.host.sessions
    .get(LEAD)
    ?.entries.push({ type: "compaction", id: "6d3bd062", timestamp: at, tokensBefore: 90_914 });
  const pump = rig.pump();
  await pump.tick();
  expect(rig.texts("prompt")).toHaveLength(1);
  expect(rig.texts("prompt")[0]).toContain("[INBOX#sys:rules-refresh:compaction-6d3bd062] ");
  expect(rig.texts("prompt")[0]).toContain("/lead/RULES.md");
  rig.working(false);
  rig.clock.at += 10 * 60_000;
  await pump.tick();
  expect(rig.texts("prompt")).toHaveLength(1);
  expect(rig.inbox.list().filter((i) => i.id.startsWith("sys:rules-refresh:"))).toHaveLength(1);
});

test("a lead without rules in its state (the omp hc lead) gets no rules refresh and no transcript read", async () => {
  rig.host.sessions.get(LEAD)?.entries.push({ type: "compaction", id: "c1", timestamp: new Date(T0).toISOString() });
  const pump = rig.pump();
  await pump.tick();
  rig.clock.at += 4 * 60 * 60_000;
  await pump.tick();
  expect(rig.inbox.list()).toEqual([]);
  expect(rig.reads).toEqual([]);
});
