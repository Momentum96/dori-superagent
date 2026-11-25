import { selfRef as hostSelf } from "./omo-host/sessions.ts";
import type { RuntimeKind, SessionRef, SessionRuntime } from "./types.ts";

const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value === "" ? undefined : value;

/**
 * The runtimes one process talks to: `default` is the selected kind (where new sessions open), `for(ref)` is the
 * runtime that owns a stored session. Each kind is built on first use and then reused.
 */
export class Runtimes {
  private readonly built = new Map<RuntimeKind, SessionRuntime>();
  private mhc: SessionRuntime | undefined;

  /** `selected` may be lazy: a stored session's runtime (`for(ref)`) never needs the choice to be made. */
  constructor(
    private readonly selected: RuntimeKind | (() => RuntimeKind),
    private readonly make: (kind: RuntimeKind, engine?: HostEngine) => SessionRuntime,
  ) {}

  get default(): SessionRuntime {
    return this.of(typeof this.selected === "function" ? this.selected() : this.selected);
  }

  for(ref: SessionRef): SessionRuntime {
    if (ref.runtime === "omo-host" && ref.engine === "mhc") {
      this.mhc ??= this.make("omo-host", "mhc");
      return this.mhc;
    }
    return this.of(ref.runtime);
  }

  /** The kinds built so far (both engines share the omo-host kind). */
  kinds(): readonly RuntimeKind[] {
    return this.mhc !== undefined && !this.built.has("omo-host")
      ? [...this.built.keys(), "omo-host"]
      : [...this.built.keys()];
  }

  instances(): readonly SessionRuntime[] {
    return this.mhc === undefined ? [...this.built.values()] : [...this.built.values(), this.mhc];
  }

  /**
   * The caller's own session from whichever runtime it runs in, whatever kind is selected: inside an omo host session
   * its PI_SESSION_ID (first: a host started from a terminal inherits that terminal's HC_TERMINAL_ID), else
   * `HC_TERMINAL_ID` names an hc terminal, else `HERDR_PANE_ID` a herdr pane (grouped by `HERDR_WORKSPACE_ID` when
   * set). Builds no runtime.
   */
  selfAny(env: Readonly<Record<string, string | undefined>>): SessionRef | undefined {
    const hosted = hostSelf(env);
    if (hosted !== undefined) return hosted;
    const terminal = nonEmpty(env["HC_TERMINAL_ID"]);
    if (terminal !== undefined) return { runtime: "hc", id: terminal };
    const pane = nonEmpty(env["HERDR_PANE_ID"]);
    if (pane === undefined) return undefined;
    const workspace = nonEmpty(env["HERDR_WORKSPACE_ID"]);
    return { runtime: "herdr", id: pane, ...(workspace === undefined ? {} : { group: workspace }) };
  }

  private of(kind: RuntimeKind): SessionRuntime {
    let runtime = this.built.get(kind);
    if (runtime === undefined) {
      runtime = this.make(kind);
      this.built.set(kind, runtime);
    }
    return runtime;
  }
}
import type { HostEngine } from "./omo-host/engine.ts";
