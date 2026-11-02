import type { Ran, Runner } from "./run.ts";

// Runs dori on herdr-core (`hc`) by translating the herdr argv the scripts emit into hc commands
// and shaping hc's JSON back into herdr's. Workspaces map to Herdr app space ids (`herdr.space`
// label); panes map to local hc terminal addresses (`t7`); agent_status is hc's own status report.

type HcListed = { readonly address: string; readonly agent?: string | null; readonly status?: string | null; readonly cwd?: string };
type HcDetail = {
  readonly pid?: number;
  readonly status?: { readonly app?: string | null; readonly state?: string | null } | null;
  readonly title?: string | null;
  readonly name?: string | null;
  readonly labels?: Readonly<Record<string, string>>;
  readonly foreground?: { readonly name?: string } | null;
};

const SHELL = /^-?(zsh|bash|sh|fish|dash|nu)$/;
const LANE_NAME = /^[a-z0-9_-]{1,32}$/;
const KEY_NAMES: Readonly<Record<string, string>> = { escape: "esc" };
const ok = (out: string): Ran => ({ code: 0, out, err: "" });
const fail = (err: string): Ran => ({ code: 1, out: "", err });
const flag = (argv: readonly string[], name: string): string | undefined => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};

const lastLines = (text: string, n: number): string => {
  const lines = text.replace(/\s+$/, "").split("\n");
  return lines.slice(-n).join("\n");
};

export const hcRunner = (run: Runner, hc = "hc"): Runner => {
  // `hc send` already presses Enter, so the Enter herdr callers send right after their text is dropped.
  let enterOwed = "";

  const listPanes = async (): Promise<Ran> => {
    const ls = await run([hc, "ls", "--json"]);
    if (ls.code !== 0) return ls;
    const local = (JSON.parse(ls.out) as { terminals: HcListed[] }).terminals.filter((t) => !t.address.includes("/"));
    const panes = [];
    for (const t of local) {
      const got = await run([hc, "get", t.address, "--json"]);
      const d = got.code === 0 ? (JSON.parse(got.out) as HcDetail) : {};
      const fg = d.foreground?.name ?? "";
      const agent = t.agent ?? (fg && !SHELL.test(fg) ? fg : undefined);
      panes.push({
        pane_id: t.address,
        workspace_id: d.labels?.["herdr.space"] ?? "",
        ...(d.labels?.["herdr.tab"] ? { tab_id: d.labels["herdr.tab"] } : {}),
        ...(agent ? { agent } : {}),
        ...(agent && t.status ? { agent_status: t.status } : {}),
        title: d.name ?? d.title ?? t.address,
        cwd: t.cwd ?? "",
      });
    }
    return ok(JSON.stringify({ result: { panes } }));
  };

  const createTab = async (argv: readonly string[]): Promise<Ran> => {
    const space = flag(argv, "--workspace");
    const cwd = flag(argv, "--cwd");
    const label = flag(argv, "--label");
    const made = await run([
      hc, "run", "--bg", "--json", "--outlive-parent", "--no-notify",
      ...(label && LANE_NAME.test(label) ? ["--name", label] : []),
      ...(cwd ? ["--cwd", cwd] : []),
      ...(space ? ["--label", `herdr.space=${space}`] : []),
      ...(label ? ["--label", `dori.lane=${label}`] : []),
    ]);
    if (made.code !== 0) return made;
    const address = (JSON.parse(made.out) as { address: string }).address;
    return ok(JSON.stringify({ result: { root_pane: { pane_id: address } } }));
  };

  return async (argv, opts) => {
    if (argv[0] !== "herdr") return run(argv, opts);
    const [, noun, verb, target = ""] = argv;
    const key = `${noun} ${verb}`;
    if (key !== "pane send-keys") enterOwed = "";
    switch (key) {
      case "pane list":
        return listPanes();
      case "pane read": {
        const lines = Number(flag(argv, "--lines") ?? 0);
        const r = await run([hc, "read", target, ...(lines ? ["--lines", String(lines)] : [])]);
        return r.code === 0 && lines ? { ...r, out: lastLines(r.out, lines) } : r;
      }
      case "pane send-text": {
        // Text pasted into a plain shell runs as a command, so only a terminal whose agent reports a status gets it.
        const got = await run([hc, "get", target, "--json"]);
        if (got.code !== 0) return got;
        const st = (JSON.parse(got.out) as HcDetail).status;
        if (!st?.app && !st?.state) return fail(`hc terminal ${target} runs no agent; text not typed`);
        const r = await run([hc, "send", target, argv[4] ?? ""]);
        if (r.code === 0) enterOwed = target;
        return r;
      }
      case "pane send-keys": {
        const keys = argv.slice(4);
        if (enterOwed === target && keys.length === 1 && keys[0] === "enter") {
          enterOwed = "";
          return ok("");
        }
        enterOwed = "";
        return run([hc, "keys", target, ...keys.map((k) => KEY_NAMES[k] ?? k)]);
      }
      case "pane run":
        return run([hc, "send", target, argv[4] ?? ""]);
      case "pane close": {
        const k = await run([hc, "kill", target]);
        if (k.code !== 0) return k;
        await run([hc, "wait", target, "--timeout", "10"]);
        await run([hc, "rm", target]);
        return k;
      }
      case "pane process-info": {
        const pane = flag(argv, "--pane") ?? target;
        const r = await run([hc, "get", pane, "--json"]);
        if (r.code !== 0) return r;
        const d = JSON.parse(r.out) as HcDetail;
        return ok(JSON.stringify({ result: { process_info: { shell_pid: d.pid ?? 0 } } }));
      }
      case "tab create":
        return createTab(argv);
      default:
        return fail(`hc backend has no equivalent for: ${argv.join(" ")}`);
    }
  };
};
