// The harness on herdr-core (`hc`). hc has terminals, not workspaces, tabs or splits: every pane is a
// terminal (`t7`), and a workspace is the Herdr app space the terminal is labelled with (`herdr.space`).
// Terminals are started with --outlive-parent so lanes survive the session that opened them.

import { interactiveShellInFront, spawnExec, type AgentStatus, type Exec, type ExecResult, type PaneRef } from "./herdr.ts";
import type { Mux } from "./mux.ts";

const ADDRESS = /^(?:[a-z0-9_-]+\/)?t[0-9][0-9a-z]*$/;
const NAME = /^[a-z0-9_-]{1,32}$/;
const NOT_FOUND = 3;
const FINISHED = 11;
const AGENT_STATES: readonly AgentStatus[] = ["idle", "working", "blocked", "done"];

export class HcError extends Error {
  constructor(readonly argv: readonly string[], readonly result: ExecResult) {
    super(`hc ${argv.join(" ")} failed (${result.code}): ${(result.stderr || result.stdout).trim()}`);
  }
}

type Terminal = {
  readonly state?: string;
  readonly status?: { readonly app?: string | null; readonly state?: string | null } | null;
  readonly labels?: Readonly<Record<string, string>>;
  readonly foreground?: { readonly name?: string; readonly argv?: readonly string[] } | null;
};

type Start = { name?: string; cwd: string; space?: string; labels: Record<string, string>; env: Record<string, string> };

export class Hc implements Mux {
  readonly kind = "hc" as const;

  constructor(
    private readonly exec: Exec = spawnExec,
    private readonly space: string | undefined = undefined,
    private readonly shell: string = process.env["SHELL"] || "/bin/zsh",
  ) {}

  private async call(argv: readonly string[]): Promise<string> {
    const res = await this.exec("hc", argv);
    if (res.code !== 0) throw new HcError(argv, res);
    return res.stdout;
  }

  /** A login shell in a new terminal. hc has no --env, so env is set by starting the shell under `env`. */
  private async start(o: Start): Promise<PaneRef> {
    const argv = ["run", "--bg", "--json", "--outlive-parent", "--no-notify", "--cwd", o.cwd];
    if (o.name && NAME.test(o.name)) argv.push("--name", o.name);
    if (o.space) argv.push("--label", `herdr.space=${o.space}`);
    for (const [k, v] of Object.entries(o.labels)) argv.push("--label", `${k}=${v}`);
    const pairs = Object.entries(o.env).map(([k, v]) => `${k}=${v}`);
    if (pairs.length > 0) argv.push("env", ...pairs, this.shell, "-l");
    const address = (JSON.parse(await this.call(argv)) as { address?: string }).address;
    if (!address) throw new Error("hc did not return a terminal address");
    return { paneId: address, tabId: "", workspaceId: o.space ?? "" };
  }

  private async get(paneId: string): Promise<Terminal | undefined> {
    const res = await this.exec("hc", ["get", paneId, "--json"]);
    if (res.code === NOT_FOUND || (res.code !== 0 && /not.?found/i.test(res.stderr))) return undefined;
    if (res.code !== 0) throw new HcError(["get", paneId], res);
    return JSON.parse(res.stdout) as Terminal;
  }

  createWorkspace(label: string, cwd: string): Promise<PaneRef> {
    return this.start({ cwd, ...(this.space ? { space: this.space } : {}), labels: { "dori.workspace": label }, env: {} });
  }

  createTab(label: string, cwd: string, workspaceId?: string, env: Record<string, string> = {}): Promise<PaneRef> {
    const space = workspaceId || this.space;
    return this.start({ name: label, cwd, ...(space ? { space } : {}), labels: { "dori.tab": label }, env });
  }

  async split(paneId: string, cwd: string, env: Record<string, string> = {}): Promise<PaneRef> {
    const space = (await this.get(paneId))?.labels?.["herdr.space"] ?? this.space;
    return this.start({ cwd, ...(space ? { space } : {}), labels: { "dori.split-of": paneId }, env });
  }

  async run(paneId: string, commandLine: string): Promise<void> {
    await this.call(["send", paneId, commandLine]);
  }

  /** hc reports agent state itself (OSC 7501); a live terminal without it is a plain shell or program. */
  async status(paneId: string): Promise<AgentStatus> {
    const t = await this.get(paneId);
    if (!t || t.state !== "live") return "gone";
    const state = t.status?.state;
    if (!t.status?.app && !state) return "shell";
    return AGENT_STATES.includes(state as AgentStatus) ? (state as AgentStatus) : "unknown";
  }

  /** Recheck immediately before sending: a terminal may have lost its agent since inbox inspection. */
  async deliver(paneId: string, text: string): Promise<boolean> {
    const terminal = await this.get(paneId);
    if (!terminal || terminal.state !== "live" || !terminal.status?.app ||
        (terminal.status.state !== "idle" && terminal.status.state !== "done") ||
        interactiveShellInFront({ foreground_processes: terminal.foreground?.name ? [terminal.foreground] : [] })) return false;
    await this.call(["send", paneId, text]);
    return true;
  }

  async typeIntoShell(_paneId: string, _text: string): Promise<boolean> {
    return false;
  }

  read(paneId: string, lines = 80): Promise<string> {
    return this.call(["read", paneId, "--lines", String(lines)]);
  }

  async close(paneId: string): Promise<void> {
    const killed = await this.exec("hc", ["kill", paneId, "--json"]);
    if (killed.code === NOT_FOUND) return;
    if (killed.code !== 0 && killed.code !== FINISHED) throw new HcError(["kill", paneId], killed);
    await this.exec("hc", ["wait", paneId, "--timeout", "10"]);
    const removed = await this.exec("hc", ["rm", paneId, "--json"]);
    if (removed.code !== 0 && removed.code !== NOT_FOUND) throw new HcError(["rm", paneId], removed);
  }

  ownPane(): string | undefined {
    return process.env["HC_TERMINAL_ID"];
  }

  // Never undefined: an hc "workspace" would only be a stray shell, so lanes open top-level when no space is set.
  ownWorkspace(): string {
    return this.space ?? "";
  }

  isPaneId(target: string): boolean {
    return ADDRESS.test(target);
  }

  // hc send pastes and presses Enter: into a plain shell that runs the text as a command, so only agents get mail.
  canReceive(status: AgentStatus): boolean {
    return status === "idle" || status === "done";
  }
}
