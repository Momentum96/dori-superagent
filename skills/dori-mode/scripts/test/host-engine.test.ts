import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Exec } from "../../../../src/runtime/exec.ts";
import { hostBinary } from "../../../../src/runtime/omo-host/engine.ts";
import { OmoHostRuntime } from "../../../../src/runtime/omo-host/index.ts";
import { FakeOmoHost, writeGoal } from "../../../../test/fake-omo-host.ts";
import { launchLane } from "../src/launch.ts";
import { leadStatus, openLead, replaceLead } from "../src/lead-session.ts";
import { type Runner, runtimesOf } from "../src/run.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";
import { LEAD, makeRig, T0 } from "./lead-pump-rig.ts";

let dir: ReturnType<typeof withState>;
beforeEach(() => {
  dir = withState();
});
afterEach(() => dir.done());

test("a launched mhc lane stays on its saved engine in a fresh runtime registry", async () => {
  const brief = join(dir.dir, "brief.md");
  writeFileSync(brief, "# brief\n");
  const mhc = new FakeOmoHost(join(dir.dir, "sessions"));
  const omo = new FakeOmoHost();
  const env = { DORI_MHC_BIN: "/fake/bin/private-mhc" };
  const run: Runner = async ([bin, ...args]) => {
    const host = bin === env.DORI_MHC_BIN ? mhc : omo;
    const r = await host.exec("omo", args);
    const session = mhc.sessions.get(args[3] ?? "");
    if (args[2] === "prompt" && session) writeGoal(session, "active");
    return { code: r.code, out: r.stdout, err: r.stderr };
  };
  const d = { ...depsFor(newWorld(), fakeClock(T0), dir.dir, { runtime: "hc" }), env, run };
  const launch = await launchLane(d, { key: "mhc-lane", title: "t", brief, done: "closed acme/app#3", engine: "mhc" });
  expect(launch.startup).toStartWith("STARTUP_OK ");
  const ref = (await d.registry.read("mhc-lane"))?.sessionRef;
  if (!ref) throw new Error("no saved ref");
  const fresh = runtimesOf({ ...d });
  const rt = fresh.for(ref);
  if (!(rt instanceof OmoHostRuntime)) throw new Error("not a host runtime");
  expect(await rt.attachArgv(ref)).toMatchObject([
    env.DORI_MHC_BIN,
    "--attach",
    expect.any(String),
    "--session",
    ref.id,
  ]);
  expect(await rt.probe(ref)).toMatchObject({ agent: "mhc", status: "working" });
  expect(await rt.deliver(ref, "continue", { when: "working" })).toMatchObject({ kind: "delivered" });
  await rt.close(ref);
  expect(await rt.read(ref, 20)).toBe("");
  expect(mhc.sessions.get(ref.id)?.parked).toBe(true);
  expect(omo.calls).toEqual([]);
});

test("lead replacement closes the recorded engine and only switches on explicit input", async () => {
  const omo = new FakeOmoHost();
  const mhc = new FakeOmoHost();
  mhc.add({ id: LEAD });
  const mhcBin = hostBinary("mhc");
  const exec: Exec = async (bin, args) => {
    if (bin === "omo") return omo.exec(bin, args);
    if (bin === mhcBin) return mhc.exec("omo", args);
    throw new Error(`unexpected binary ${bin}`);
  };
  const d = { stateDir: dir.dir, exec, clock: fakeClock(T0), alert: async () => {} };
  const rulesFile = join(dir.dir, "rules.md");
  writeFileSync(rulesFile, "# rules\n");
  const input = { bot: "bot", runtime: "omo-host", cwd: dir.dir, rulesFile, model: "mock/model" } as const;
  const first = await openLead(d, { ...input, engine: "mhc" });
  mhc.refuseNext.set("open", "host_unavailable");
  await expect(replaceLead(d, input)).rejects.toThrow("host_unavailable");
  const recovered = await replaceLead(d, input);
  expect(recovered.lead).toMatchObject({ engine: "mhc", generation: 2 });
  expect(omo.calls).toEqual([]);
  await replaceLead(d, { bot: input.bot, rulesFile, engine: "omo" });
  const active = await leadStatus(dir.dir, input.bot);
  expect(active).toMatchObject({ engine: "omo", generation: 3, retired: [first.sessionId, recovered.lead.sessionId] });
  expect(mhc.sessions.get(recovered.lead.sessionId)?.parked).toBe(true);
  expect(omo.sessions.get(active.sessionId)).toMatchObject({
    state: { model: { provider: "mock", id: "model" } },
    entries: [{ message: { content: `@${rulesFile}` } }],
  });
  mhc.refuseNext.set("open", "host_unavailable");
  await expect(replaceLead(d, { ...input, engine: "mhc" })).rejects.toThrow("host_unavailable");
  expect(await leadStatus(dir.dir, input.bot)).toMatchObject({
    state: "switching",
    engine: "omo",
    openingEngine: "mhc",
  });
  const resumed = await replaceLead(d, input);
  expect(resumed.lead).toMatchObject({ state: "active", engine: "mhc", generation: 4 });
  expect(omo.sessions.get(active.sessionId)?.parked).toBe(true);
  expect(mhc.sessions.get(resumed.lead.sessionId)?.parked).toBeUndefined();
});

test("a pump follows an engine switch without reporting a restart, then detects an mhc restart from saved health", async () => {
  const rig = makeRig(dir.dir);
  try {
    rig.mhc.add({ id: "11a1f9b4-1cb7-72b3-aeb1-f6243c3aa102" });
    rig.mhc.status = { ...rig.mhc.status, pid: 5151 };
    const pump = rig.pump();
    await pump.tick();
    const omoCalls = rig.host.calls.length;
    rig.writeLead({ engine: "mhc", sessionId: "11a1f9b4-1cb7-72b3-aeb1-f6243c3aa102", generation: 2 });
    rig.put("report:after-switch");
    await pump.tick();
    expect(rig.inbox.list("done").map((i) => i.id)).toContain("report:after-switch");
    expect(rig.inbox.list("done").some((i) => i.id.startsWith("sys:host-restart:"))).toBe(false);
    await pump.health();
    expect(rig.health()["host"]).toMatchObject({ engine: "mhc", pid: 5151 });
    rig.mhc.status = { ...rig.mhc.status, pid: 5252 };
    await rig.pump().tick();
    expect(
      rig.inbox
        .list("done")
        .map((i) => i.body)
        .join("\n"),
    ).toContain("mhc's engine host restarted");
    expect(rig.host.calls).toHaveLength(omoCalls);
  } finally {
    rig.inbox.close();
  }
});

test("the CLI opens an mhc lead and the pump uses its configured binary for status and file-backed reads", async () => {
  const bin = join(dir.dir, "fake-mhc");
  const id = LEAD;
  const report = join(dir.dir, "verbs");
  writeFileSync(
    bin,
    `#!/bin/sh
printf '%s\\n' "$2 $3" >> "${report}"
case "$2 $3" in
  "session open") printf '%s\\n' '{"durableSessionId":"${id}"}';;
  "status --json") printf '%s\\n' '{"reachable":true,"lifecycle":"ready","pid":5151}';;
  "session list") printf '%s\\n' '{"sessions":[{"durableSessionId":"${id}","activity":"idle"}]}';;
  "session read") printf '%s\\n' '{"entries":[]}';;
  *) exit 2;;
esac
`,
    { mode: 0o700 },
  );
  // No real host can run, even if routing regresses to the historical binary.
  writeFileSync(join(dir.dir, "omo"), "#!/bin/sh\nexit 97\n", { mode: 0o700 });
  const config = join(dir.dir, "config.json");
  writeFileSync(config, JSON.stringify({ stateDir: dir.dir, runtime: "hc" }));
  const cli = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args], {
      cwd: dir.dir,
      env: { PATH: dir.dir, DORI_CONFIG: config, DORI_MHC_BIN: bin, HOME: dir.dir },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { out, err, code };
  };
  const rules = join(dir.dir, "rules.md");
  writeFileSync(rules, "# rules\n");
  expect(
    await cli(
      "lead",
      "open",
      "--bot",
      "bot",
      "--cwd",
      dir.dir,
      "--model",
      "fake/m",
      "--rules",
      rules,
      "--engine",
      "mhc",
    ),
  ).toMatchObject({ out: expect.stringContaining("LEAD_OPEN"), code: 0 });
  expect(await cli("lead-pump", "--bot", "bot", "--once")).toMatchObject({ code: 0 });
  expect(await Bun.file(report).text()).toContain("status --json\nsession list\nsession read\n");
});
