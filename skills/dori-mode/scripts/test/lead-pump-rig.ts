// One lead pump over a FakeOmoHost (and an hc world for an hc lead), a fake clock and a temp state dir. Every omo
// call goes through the same Runner the pump gets, so the fake host sees exactly the argv the real CLI would.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { FakeOmoHost } from "../../../../test/fake-omo-host.ts";
import { LeadInbox } from "../src/lead-inbox.ts";
import { LeadPump } from "../src/lead-pump.ts";
import { parseHostStatus } from "../src/lead-pump-text.ts";
import { type LeadState, writeLeadState } from "../src/lead-state.ts";
import type { Ran, Runner } from "../src/run.ts";
import { runtimesFor } from "../src/run.ts";
import { fakeClock } from "./fakes.ts";
import { type HcWorld, hcAnswer } from "./hc-runner.ts";

export const T0 = Date.parse("2026-11-21T02:00:00.000Z");
export const LEAD = "01a1f9b4-1cb7-72b3-aeb1-f6243c3aa102";

export type Rig = ReturnType<typeof makeRig>;

export const makeRig = (dir: string, lead: Partial<LeadState> = {}) => {
  const host = new FakeOmoHost();
  host.add({ id: LEAD, name: "dori-lead-omo", cwd: "/lead" });
  const hc: HcWorld = { terminals: {} };
  const clock = fakeClock(T0);
  const hooks: string[][] = [];
  let hookCode = 0;
  const runs: { argv: readonly string[]; timeoutMs: number | undefined }[] = [];
  /** Wraps every call the pump makes; a test swaps it to act between calls (a turn ending before a steer). */
  let before: (argv: readonly string[]) => void = () => {};
  const runner: Runner = async (argv, opts) => {
    runs.push({ argv, timeoutMs: opts?.timeoutMs });
    before(argv);
    const [cmd = "", ...rest] = argv;
    if (cmd === "hc") return hcAnswer(hc, argv);
    if (cmd !== "omo") {
      hooks.push([...argv]);
      return { code: hookCode, out: "", err: hookCode === 0 ? "" : "reaction refused" };
    }
    const r = await host.exec(cmd, rest);
    return { code: r.code, out: r.stdout, err: r.stderr } satisfies Ran;
  };
  /**
   * `read` as the pump's file reader gets it: a non-zero exit throws with the output, as cli-lead-pump's reader does.
   * `cut` stands in for a pipe that stops at that many bytes.
   */
  const reads: number[] = [];
  let cut = Number.POSITIVE_INFINITY;
  const writeLead = (over: Partial<LeadState> = {}): void =>
    writeLeadState(dir, {
      bot: "omo",
      runtime: "omo-host",
      generation: 1,
      sessionId: LEAD,
      state: "active",
      retired: [],
      cwd: "/lead",
      ...lead,
      ...over,
    });
  writeLead();
  const inbox = new LeadInbox(dir, "omo", clock);
  const pump = (): LeadPump =>
    new LeadPump({
      stateDir: dir,
      bot: "omo",
      clock,
      inbox,
      runtimes: runtimesFor({ runtime: "hc", leadRuntime: "omo-host" }, {}, runner, clock),
      host: async () => parseHostStatus((await runner(["omo", "host", "status", "--json"])).out),
      transcript: async (id, { tail, messages }) => {
        reads.push(tail);
        const argv = ["read", id, ...(messages ? ["--messages"] : []), "--tail", String(tail), "--json"];
        const r = await runner(["omo", "host", "session", ...argv]);
        if (r.code !== 0) throw new Error(`omo host session read exited ${r.code}: ${r.out || r.err}`);
        return r.out.slice(0, cut);
      },
      run: runner,
      hookArgv: ["react", "{id}", "{channel}", "{message}"],
      bootTime: "2026-11-20T00:00:00.000Z",
    });
  const texts = (verb: "prompt" | "steer"): string[] => host.calls.filter((c) => c[0] === verb).map((c) => c[2] ?? "");
  return {
    host,
    hc,
    clock,
    hooks,
    runs,
    reads,
    inbox,
    pump,
    writeLead,
    texts,
    setBefore: (f: (argv: readonly string[]) => void) => {
      before = f;
    },
    setHookCode: (code: number) => {
      hookCode = code;
    },
    setCut: (bytes: number) => {
      cut = bytes;
    },
    put: (id: string, body = `body of ${id}`, extra: { channel?: string; message?: string } = {}) =>
      inbox.put({ id, kind: "report", source: "lane-x", body, ...extra }),
    /** How many delivered texts (prompts and steers) carry this item's token. */
    sends: (id: string): number =>
      [...texts("prompt"), ...texts("steer")].filter((t) => t.includes(`[INBOX#${id}] `)).length,
    /** The host transcript holds this text as a user message (what a prompt the host took leaves behind). */
    said: (text: string): void => {
      host.sessions.get(LEAD)?.entries.push({ type: "message", message: { role: "user", content: text } });
    },
    working: (on: boolean): void => {
      const s = host.sessions.get(LEAD);
      if (s) s.state = { ...s.state, isStreaming: on };
    },
    health: (): Record<string, Record<string, unknown>> =>
      JSON.parse(readFileSync(join(dir, "health", "omo.json"), "utf8")) as Record<string, Record<string, unknown>>,
  };
};
