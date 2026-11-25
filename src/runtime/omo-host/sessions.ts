import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { AgentStatus, CreateSpec, Probe, SessionInfo, SessionRef } from "../types.ts";
import type { HostEngine } from "./engine.ts";
import { type HostCall, isReason, rec, str } from "./exec.ts";

const DEFAULT_GROUP = "dori";
const engineField = (engine: HostEngine): Pick<SessionRef, "engine"> => (engine === "omo" ? {} : { engine });

/** The host has no labels: a Dori session's name carries its group, `dori/<group>/<name>`, so list can filter on it. */
export const sessionName = (spec: Pick<CreateSpec, "name" | "group">): string =>
  `dori/${spec.group ?? DEFAULT_GROUP}/${spec.name}`;
const nameParts = (name: string | undefined): { readonly group: string; readonly name: string } | undefined => {
  const m = name === undefined ? null : /^dori\/([^/]+)\/(.+)$/.exec(name);
  return m?.[1] === undefined || m[2] === undefined ? undefined : { group: m[1], name: m[2] };
};

/**
 * `open --cwd --model --name`: an idle agent session the host retains after this call exits. The ref id is the durable
 * session id (it survives a park or a host restart; the routing handle does not), which is also PI_SESSION_ID inside it.
 * A host session runs in the host's own environment, so an env cannot be applied: it is refused, never dropped.
 */
export async function create(call: HostCall, engine: HostEngine, spec: CreateSpec): Promise<SessionRef> {
  const keys = Object.keys(spec.env);
  if (keys.length > 0)
    throw new Error(`an omo-host session cannot carry env (${keys.join(", ")}); pass it in the agent's commands`);
  const opened = await call([
    "open",
    "--cwd",
    spec.cwd,
    ...(spec.model === undefined ? [] : ["--model", spec.model]),
    "--name",
    sessionName(spec),
  ]);
  const id = str(opened["durableSessionId"]);
  if (id === undefined) throw new Error(`${engine} host session open did not return a durableSessionId`);
  return { runtime: "omo-host", id, group: spec.group ?? DEFAULT_GROUP, ...engineField(engine) };
}

const rows = (listed: Record<string, unknown>): Record<string, unknown>[] =>
  Array.isArray(listed["sessions"]) ? listed["sessions"].map(rec) : [];

/** The host's live sessions (`list` only observes: it never resumes a parked session or counts as occupancy). */
export async function list(call: HostCall, engine: HostEngine, group: string | undefined): Promise<SessionInfo[]> {
  const out: SessionInfo[] = [];
  for (const row of rows(await call(["list"]))) {
    const id = str(row["durableSessionId"]);
    if (id === undefined || row["archived"] === true) continue;
    const parts = nameParts(str(row["name"]));
    if (group !== undefined && parts?.group !== group) continue;
    const [name, cwd] = [parts?.name ?? str(row["name"]), str(row["cwd"])];
    out.push({
      ref: { runtime: "omo-host", id, ...engineField(engine), ...(parts === undefined ? {} : { group: parts.group }) },
      ...(name === undefined ? {} : { name }),
      ...(cwd === undefined ? {} : { cwd }),
      status: row["activity"] === "running" ? "working" : "idle",
      agent: engine,
    });
  }
  return out;
}

/** `state` of one session, or undefined when the host knows no such session. A parked one is resumed by the call. */
export async function stateOf(call: HostCall, id: string): Promise<Record<string, unknown> | undefined> {
  try {
    return rec((await call(["state", id]))["state"]);
  } catch (e) {
    if (isReason(e, "unknown_session")) return undefined;
    throw e;
  }
}

/**
 * working: a turn or compaction runs; else idle. A pending question or dialog is idle too, never blocked: in a host
 * session the agent's question tool answers "the answer will arrive as a user message", so the next prompt is the answer.
 */
export function statusOf(state: Record<string, unknown>): AgentStatus {
  return state["isStreaming"] === true || state["isCompacting"] === true ? "working" : "idle";
}

/**
 * omo's goal record for the session: `<session dir>/extensions/goal/<session id>.json` holding `{ goal: { status } }`,
 * the record omo's own goal footer is drawn from. `none` when the session has no goal (or no record yet).
 */
export function goalOf(state: Record<string, unknown>): string {
  const [file, id] = [str(state["sessionFile"]), str(state["sessionId"])];
  if (file === undefined || id === undefined) return "none";
  try {
    const record = rec(
      JSON.parse(readFileSync(join(dirname(file), "extensions", "goal", `${encodeURIComponent(id)}.json`), "utf8")),
    );
    return str(rec(record["goal"])["status"]) ?? "none";
  } catch {
    return "none";
  }
}

const listed = (value: unknown): number => (Array.isArray(value) ? value.length : 0);

/**
 * A question or dialog waits on a person. A select dialog shows in `pendingDialogs` and `lifecycle.waitingOn.human`
 * while `pendingQuestions` stays empty and the session reads as streaming (spike S1, check g).
 */
const waitsOnHuman = (state: Record<string, unknown>): boolean =>
  listed(state["pendingQuestions"]) +
    listed(state["pendingDialogs"]) +
    listed(rec(rec(state["lifecycle"])["waitingOn"])["human"]) >
  0;

export function probeOf(state: Record<string, unknown> | undefined, engine: HostEngine): Probe {
  if (state === undefined) return { status: "gone", shellInFront: false };
  const [title, cwd] = [str(state["sessionName"]), str(state["cwd"])];
  return {
    ...(waitsOnHuman(state) ? { waitingOnHuman: true } : {}),
    status: statusOf(state),
    agent: engine,
    ...(title === undefined ? {} : { title }),
    ...(cwd === undefined ? {} : { cwd }),
    shellInFront: false,
    goal: goalOf(state),
  };
}

/**
 * `close`. `closed: false` means another client (a `dori attach` view) still holds the session, and the host never
 * forces it: the running turn is stopped and the close fails with the way out, so the lane's receipt says not closed.
 */
export async function close(call: HostCall, binary: string, id: string): Promise<void> {
  let closed: Record<string, unknown>;
  try {
    closed = await call(["close", id]);
  } catch (e) {
    if (isReason(e, "unknown_session")) return;
    throw e;
  }
  if (closed["closed"] !== false) return;
  await call(["abort", id]);
  throw new Error(
    `${binary} host session ${id} is still attached by a viewer: quit it, then ${binary} host session close ${id}`,
  );
}

/** The caller's own host session: PI_SESSION_ID, only inside a host (SENPI_RPC_HOST_PUBLIC_SOCKET set). */
export function selfRef(env: Readonly<Record<string, string | undefined>>): SessionRef | undefined {
  const [socket, id] = [env["SENPI_RPC_HOST_PUBLIC_SOCKET"], env["PI_SESSION_ID"]];
  // The mhc wrapper runs the host and its children under this isolated HOME.
  const engine = env["HOME"]?.endsWith("/.maho/home") ? "mhc" : "omo";
  return socket && id ? { runtime: "omo-host", id, ...engineField(engine) } : undefined;
}
