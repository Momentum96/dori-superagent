import { expect, test } from "bun:test";
import { mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { importSpool } from "../src/cli-lead-inbox.ts";
import { LeadInbox } from "../src/lead-inbox.ts";
import { realClock } from "../src/run.ts";
import { withState } from "./fakes.ts";

const cli = join(import.meta.dir, "../src/cli.ts");

const dori = async (dir: string, args: readonly string[], stdin = "") => {
  const config = join(dir, "config.json");
  writeFileSync(config, JSON.stringify({ stateDir: dir, defaultCwd: dir, hooks: {} }));
  const proc = Bun.spawn([process.execPath, cli, ...args], {
    env: { ...process.env, DORI_CONFIG: config, DORI_STATE_DIR: dir },
    stdin: new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out: out.trim(), err: err.trim() };
};

const rows = (dir: string) => {
  const inbox = new LeadInbox(dir, "omo", realClock);
  const all = inbox.list();
  inbox.close();
  return all;
};

test("dori lead-inbox put answers inserted then duplicate, stats counts one queued, a bad id exits 2", async () => {
  const state = withState();
  try {
    const put = ["lead-inbox", "put", "--bot", "omo", "--kind", "event", "--source", "qa"];
    expect(await dori(state.dir, [...put, "--id", "t:1"], "hello")).toEqual({ code: 0, out: "inserted", err: "" });
    expect(await dori(state.dir, [...put, "--id", "t:1"], "hello")).toEqual({ code: 0, out: "duplicate", err: "" });
    const stats = await dori(state.dir, ["lead-inbox", "stats", "--bot", "omo", "--json"]);
    expect((JSON.parse(stats.out) as { queued: number }).queued).toBe(1);
    const bad = await dori(state.dir, [...put, "--id", "bad id"], "hello");
    expect([bad.code, bad.out, bad.err.startsWith('invalid id "bad id"')]).toEqual([2, "", true]);
    expect((await dori(state.dir, ["lead-inbox", "put", "--bot", "../x", ...put.slice(4), "--id", "t:2"])).code).toBe(
      2,
    );
    expect(rows(state.dir).map((r) => [r.id, r.body])).toEqual([["t:1", "hello"]]);
  } finally {
    state.done();
  }
});

test("dori lead-inbox put --envelope stores channel and message; a broken envelope exits 2", async () => {
  const state = withState();
  try {
    const envelope = { id: "discord:77", kind: "owner", source: "watch", body: "hi", channel: "c1", message: "m1" };
    const put = ["lead-inbox", "put", "--bot", "omo", "--envelope"];
    expect((await dori(state.dir, put, JSON.stringify(envelope))).out).toBe("inserted");
    for (const bad of ['{"id":"discord:78"', JSON.stringify({ ...envelope, id: "x" }), "[]"])
      expect((await dori(state.dir, put, bad)).code).toBe(2);
    const listed = await dori(state.dir, ["lead-inbox", "list", "--bot", "omo", "--state", "queued", "--json"]);
    expect(JSON.parse(listed.out)).toMatchObject([{ seq: 1, ...envelope, state: "queued", attempts: 0 }]);
    expect((await dori(state.dir, ["lead-inbox", "list", "--bot", "omo", "--state", "lost"])).code).toBe(2);
  } finally {
    state.done();
  }
});

test("an edit with replaces rewrites a still-queued original, adds a row once it was sent, inserts for an unknown id", async () => {
  const state = withState();
  try {
    const put = ["lead-inbox", "put", "--bot", "omo", "--envelope"];
    const request = (n: number, content: string) => ({
      id: `d:omo:13000000000000000${n}`,
      kind: "request",
      source: "discord",
      body: JSON.stringify({ content }),
      channel: "c1",
      message: `13000000000000000${n}`,
    });
    const edit = (n: number, content: string, replaces = request(n, "").id) => ({
      ...request(n, content),
      id: `e:omo:13000000000000000${n}:176365000000${n}`,
      kind: "edit",
      replaces,
    });
    const send = async (envelope: object) => {
      const r = await dori(state.dir, put, JSON.stringify(envelope));
      return [r.code, r.out, r.err];
    };
    const content = (body: string | undefined) => (JSON.parse(body ?? "null") as { content: string }).content;

    // The gate review's repro: request, edit while queued, replay of the request.
    expect(await send(request(1, "old"))).toEqual([0, "inserted", ""]);
    expect(await send(edit(1, "new"))).toEqual([0, "replaced", ""]);
    expect(await send(request(1, "old"))).toEqual([0, "duplicate", ""]);
    // The watcher replays the edit after a kill before it saved: same answer, no second row.
    expect(await send(edit(1, "new"))).toEqual([0, "replaced", ""]);
    // The original was already sent: the lead has the old text, so the edit becomes its own item.
    expect(await send(request(2, "asked"))).toEqual([0, "inserted", ""]);
    const inbox = new LeadInbox(state.dir, "omo", realClock);
    inbox.mark(
      inbox.list().flatMap((i) => (i.id === request(2, "").id ? [i.seq] : [])),
      "sent",
    );
    inbox.close();
    expect(await send(edit(2, "changed"))).toEqual([0, "inserted", ""]);
    expect(await send(edit(2, "changed"))).toEqual([0, "duplicate", ""]);
    // replaces names nothing in this inbox: insert as before.
    expect(await send(edit(3, "orphan"))).toEqual([0, "inserted", ""]);
    const bad = await dori(state.dir, put, JSON.stringify(edit(4, "x", "bad id")));
    expect([bad.code, bad.out, bad.err.startsWith('invalid replaces "bad id"')]).toEqual([2, "", true]);

    expect(rows(state.dir).map((r) => [r.id, r.kind, r.state, content(r.body)])).toEqual([
      ["d:omo:130000000000000001", "request", "queued", "new"],
      ["d:omo:130000000000000002", "request", "sent", "asked"],
      ["e:omo:130000000000000002:1763650000002", "edit", "queued", "changed"],
      ["e:omo:130000000000000003:1763650000003", "edit", "queued", "orphan"],
    ]);
  } finally {
    state.done();
  }
});

test("import-spool puts oldest first, deletes only answered files, moves invalid ones to rejected/", () => {
  const state = withState();
  try {
    const spool = join(state.dir, "spool");
    mkdirSync(spool);
    const drop = (name: string, content: string, secondsAgo: number) => {
      writeFileSync(join(spool, name), content);
      const at = new Date(Date.now() - secondsAgo * 1000);
      utimesSync(join(spool, name), at, at);
    };
    const env = (id: string, body: string) => JSON.stringify({ id, kind: "report", source: "fwd", body });
    drop("b.json", env("report:1", "second copy"), 10);
    drop("a.json", env("report:1", "first copy"), 30);
    drop("bad.json", '{"id":"report:2","kind":', 20);
    drop("c.json.tmp", env("report:3", "still being written"), 40);
    const inbox = new LeadInbox(state.dir, "omo", realClock);
    expect(importSpool(inbox, spool).map((r) => [r.file, r.outcome])).toEqual([
      ["a.json", "inserted"],
      ["bad.json", "rejected"],
      ["b.json", "duplicate"],
    ]);
    expect(inbox.list().map((i) => [i.id, i.body])).toEqual([["report:1", "first copy"]]);
    expect(readdirSync(spool).sort()).toEqual(["c.json.tmp", "rejected"]);
    expect(readdirSync(join(spool, "rejected"))).toEqual(["bad.json"]);
    expect(importSpool(inbox, spool)).toEqual([]);
    inbox.close();
  } finally {
    state.done();
  }
});

test("dori lead-inbox import-spool runs one pass and refuses a --loop that swallowed a flag", async () => {
  const state = withState();
  try {
    const spool = join(state.dir, "spool");
    mkdirSync(spool);
    writeFileSync(join(spool, "1.json"), JSON.stringify({ id: "report:5", kind: "report", source: "fwd", body: "b" }));
    const once = await dori(state.dir, ["lead-inbox", "import-spool", "--bot", "omo", "--spool", spool]);
    expect([once.code, once.out]).toEqual([0, "SPOOL inserted 1.json"]);
    const swallowed = await dori(state.dir, ["lead-inbox", "import-spool", "--loop", "--bot", "omo", "--spool", spool]);
    expect(swallowed.code).not.toBe(0);
    expect(readdirSync(spool)).toEqual([]);
    const missing = await dori(state.dir, [
      "lead-inbox",
      "import-spool",
      "--bot",
      "omo",
      "--spool",
      join(spool, "nope"),
    ]);
    expect([missing.code, missing.err]).toEqual([2, `no spool directory ${join(spool, "nope")}`]);
  } finally {
    state.done();
  }
});
