import type { Clock, Runner } from "./run.ts";

export type Pane = {
  readonly pane_id: string;
  readonly workspace_id: string;
  readonly tab_id?: string;
  readonly agent?: string;
  readonly agent_status?: string;
  readonly title?: string;
  readonly cwd?: string;
};

export class UnsafeTextError extends Error {}

export const listPanes = async (run: Runner): Promise<Pane[]> => {
  const r = await run(["herdr", "pane", "list"]);
  if (r.code !== 0) throw new Error(`herdr pane list failed: ${r.err || r.out}`);
  return (JSON.parse(r.out) as { result: { panes: Pane[] } }).result.panes;
};

export const readScreen = async (run: Runner, pane: string, lines?: number): Promise<string> =>
  (await run(["herdr", "pane", "read", pane, "--source", lines ? "recent" : "visible", ...(lines ? ["--lines", String(lines)] : [])])).out;

/** States herdr reports for a pane whose agent is running. A screen read never stands in for these. */
export const ALIVE_STATUSES: ReadonlySet<string> = new Set(["idle", "working", "blocked", "done"]);

export const agentStatus = async (run: Runner, pane: string): Promise<string | undefined> =>
  (await listPanes(run)).find((p) => p.pane_id === pane)?.agent_status;

/** Like agentStatus, but a failed lookup comes back as its error text instead of being swallowed. */
export const statusLookup = async (run: Runner, pane: string): Promise<{ readonly status?: string; readonly error?: string }> => {
  try {
    return { status: await agentStatus(run, pane) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
};

const SHELLS: ReadonlySet<string> = new Set([
  "sh", "ash", "bash", "zsh", "fish", "dash", "ksh", "mksh", "tcsh", "csh", "nu", "elvish", "xonsh", "pwsh", "powershell", "busybox",
]);
const baseName = (value: unknown): string => String(value ?? "").replace(/^-/, "").split("/").pop()!.toLowerCase();
// A shell runs a command (not a prompt) only with an explicit command flag: -c, also inside combined short flags such
// as -lc, or PowerShell's -Command/-File/-EncodedCommand (whole words only: its other long flags contain a 'c'). Any other operand (a script path, --rcfile FILE, -o OPT) stays held.
const runsCommand = (shell: string, arg: string): boolean =>
  shell === "pwsh" || shell === "powershell"
    ? /^-(c|command|f|file|e|ec|encodedcommand)$/i.test(arg)
    : /^-[A-Za-z]*c[A-Za-z]*$/.test(arg);
// PowerShell's -NoExit (any prefix it accepts: -noe, -noex, -noexi, -noexit, one or two dashes) keeps an interactive
// prompt after the command runs, so that shell is held.
const keepsPrompt = (shell: string, arg: string): boolean => (shell === "pwsh" || shell === "powershell") && /^--?noe(x(i(t)?)?)?$/i.test(arg);

/**
 * True when `herdr pane process-info` shows an interactive shell in the pane's foreground group, or cannot be read.
 * herdr still reports an agent suspended with Ctrl+Z as idle while its shell is in front (#66); a shell running a
 * command flag (`sh -c ...`) is the agent's child and does not count; any other shell, `bash script.sh` included,
 * is held. Same rule as dori's src/herdr.ts.
 */
export const shellInFront = async (run: Runner, pane: string): Promise<boolean> => {
  try {
    const r = await run(["herdr", "pane", "process-info", "--pane", pane]);
    if (r.code !== 0) throw new Error(r.err || r.out);
    const procs = (JSON.parse(r.out) as { result?: { process_info?: { foreground_processes?: unknown } } }).result?.process_info?.foreground_processes;
    if (!Array.isArray(procs) || procs.length === 0) return true;
    for (const proc of procs as { name?: unknown; argv?: unknown }[]) {
      let name = baseName(proc?.name);
      let args = Array.isArray(proc?.argv) ? proc.argv.map(String).slice(1) : undefined;
      if (name === "busybox" && args && args.length > 0) [name, args] = [baseName(args[0]), args.slice(1)];
      if (!SHELLS.has(name)) continue;
      if (args === undefined) return true;
      if (!args.some((a) => runsCommand(name, a)) || args.some((a) => keepsPrompt(name, a))) return true;
    }
    return false;
  } catch (e) {
    console.error(`sendVerified ${pane}: herdr pane process-info failed (${e instanceof Error ? e.message : String(e)}); holding the send`);
    return true;
  }
};

export type Delivery = "delivered" | "unconfirmed" | "failed";

/**
 * Types the text and presses Enter exactly once. Delivery is confirmed only by a state change: the pane's agent_status
 * moving to "working" from something else. A pane that was already working cannot show that change, so its send comes
 * back "unconfirmed" and the caller decides. The screen is never read here, and Enter is never pressed again.
 */
export const sendVerified = async (run: Runner, clock: Clock, pane: string, text: string): Promise<Delivery> => {
  if (/`|\$\(/.test(text)) throw new UnsafeTextError("refusing to send text containing a backtick or $(");
  const before = await statusLookup(run, pane);
  if (before.error) console.error(`sendVerified ${pane}: status lookup failed before send: ${before.error}`);
  // No running agent means a bare shell, where typed text runs as a command (#66). A failed lookup is doubt: refuse.
  if (before.status === undefined || !ALIVE_STATUSES.has(before.status)) return "failed";
  if (await shellInFront(run, pane)) return "failed";
  if ((await run(["herdr", "pane", "send-text", pane, text])).code !== 0) return "failed";
  await run(["herdr", "pane", "send-keys", pane, "enter"]);
  if (before.status === "working") return "unconfirmed";
  for (let attempt = 0; attempt < 6; attempt++) {
    await clock.sleep(700);
    const after = await statusLookup(run, pane);
    if (after.error) console.error(`sendVerified ${pane}: status lookup failed: ${after.error}`);
    if (after.status === "working") return "delivered";
  }
  return "unconfirmed";
};
