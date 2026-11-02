import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, type DoriConfig } from "../skills/dori-mode/scripts/src/config.ts";
import { Registry } from "../skills/dori-mode/scripts/src/registry.ts";
import type { Runner } from "../skills/dori-mode/scripts/src/run.ts";
import type { Deps } from "../src/harness.ts";
import { Herdr, type AgentStatus, type Exec } from "../src/herdr.ts";
import { Store } from "../src/store.ts";

type Pane = { status: AgentStatus; tab: string; received: string[]; ran: string[]; screen: string };

/** A fake herdr (plus gh, a reviewer and a messenger hook) behind both the harness's Exec and Dori mode's Runner. */
export class World {
  panes = new Map<string, Pane>();
  calls: { cmd: string; argv: readonly string[] }[] = [];
  clock = 1_000_000;
  next = 1;
  gh: (argv: readonly string[]) => { code: number; stdout: string } = () => ({ code: 1, stdout: "" });
  reviewer: (argv: readonly string[]) => { code: number; stdout: string } = () => ({ code: 0, stdout: "VERDICT: CLEAR" });
  hc: (argv: readonly string[]) => { code: number; stdout: string } = () => ({ code: 1, stdout: "" });

  addPane(id: string, status: AgentStatus = "idle", tab = "w1:t1"): Pane {
    const p = { status, tab, received: [], ran: [], screen: "" };
    this.panes.set(id, p);
    return p;
  }

  posts(): string[][] {
    return this.calls.filter((c) => c.cmd === "notify").map((c) => [...c.argv]);
  }

  exec: Exec = async (cmd, argv) => {
    this.calls.push({ cmd, argv });
    const ok = (result: unknown = {}) => ({ code: 0, stdout: JSON.stringify({ result }), stderr: "" });
    if (cmd === "gh") return { ...this.gh(argv), stderr: "" };
    if (cmd === "notify") return { code: 0, stdout: "", stderr: "" };
    if (cmd === "git") return { code: 1, stdout: "", stderr: "not a repository" };
    if (cmd === "hc") return { ...this.hc(argv), stderr: "" };
    if (cmd !== "herdr") return { ...this.reviewer(argv), stderr: "" };
    const [group, verb, id] = argv;
    if ((group === "tab" || group === "workspace") && verb === "create") {
      const n = ++this.next;
      this.addPane(`w1:p${n}`, "shell", `w1:t${n}`);
      return ok({ root_pane: { pane_id: `w1:p${n}`, tab_id: `w1:t${n}`, workspace_id: "w1" } });
    }
    if (group === "pane" && verb === "split") {
      const pane = `w1:p${++this.next}`;
      this.addPane(pane, "shell");
      return ok({ pane: { pane_id: pane, tab_id: "w1:t1", workspace_id: "w1" } });
    }
    if (group === "pane" && verb === "list") {
      const panes = [...this.panes].map(([pane_id, p]) => ({
        pane_id, workspace_id: "w1", tab_id: p.tab,
        ...(p.status === "shell" ? {} : { agent: "omo", agent_status: p.status }),
      }));
      return ok({ panes });
    }
    if (group === "tab" && verb === "close") {
      for (const [k, p] of this.panes) if (p.tab === id) this.panes.delete(k);
      return ok();
    }
    const pane = id ? this.panes.get(id) : undefined;
    if (!pane) return { code: 1, stdout: "", stderr: `pane_not_found ${id}` };
    if (group === "pane" && verb === "get") {
      return ok({ pane: { pane_id: id, agent: pane.status === "shell" ? null : "omo", agent_status: pane.status } });
    }
    if (group === "pane" && verb === "run") {
      pane.ran.push(String(argv[3]));
      if (/^omo\b/.test(String(argv[3]))) pane.status = "idle";
      return ok();
    }
    if (group === "pane" && (verb === "send-text")) { pane.received.push(String(argv[3])); return ok(); }
    if (group === "agent" && verb === "prompt") { pane.received.push(String(argv[3])); return ok(); }
    if (group === "pane" && verb === "send-keys") return ok();
    if (group === "pane" && verb === "read") return { code: 0, stdout: pane.screen, stderr: "" };
    if (group === "pane" && verb === "process-info") return ok({ process_info: { shell_pid: 0 } });
    if (group === "pane" && verb === "close") { this.panes.delete(id!); return ok(); }
    return { code: 1, stdout: "", stderr: `unhandled ${argv.join(" ")}` };
  };

  runner: Runner = async (argv) => {
    const r = await this.exec(argv[0]!, argv.slice(1));
    return { code: r.code, out: r.stdout.trim(), err: r.stderr.trim() };
  };

  deps(patch: Partial<DoriConfig> = {}): Deps {
    const stateDir = mkdtempSync(join(tmpdir(), "dori-state-"));
    const config: DoriConfig = {
      ...defaultConfig("/home/test"), stateDir, defaultCwd: stateDir, hooks: { threadReply: ["notify", "{thread}", "{text}"] }, ...patch,
    };
    return {
      store: new Store(mkdtempSync(join(tmpdir(), "dori-test-"))),
      mux: new Herdr(this.exec, undefined),
      exec: this.exec,
      now: () => this.clock,
      agentCmd: "omo",
      doriCmd: "dori",
      flow: { run: this.runner, clock: { now: () => this.clock, sleep: async () => {} }, registry: new Registry(stateDir), config, exists: () => true },
    };
  }
}
