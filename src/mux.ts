// The terminal multiplexer the harness drives. Two implementations: herdr (`src/herdr.ts`, the default)
// and herdr-core's `hc` (`src/hc.ts`), picked by `mux` in the Dori mode config (DORI_MUX overrides it).

import { Hc } from "./hc.ts";
import { Herdr, spawnExec, type AgentStatus, type Exec, type PaneRef } from "./herdr.ts";

export type MuxKind = "herdr" | "hc";

export interface Mux {
  readonly kind: MuxKind;
  createWorkspace(label: string, cwd: string): Promise<PaneRef>;
  createTab(label: string, cwd: string, workspaceId?: string, env?: Record<string, string>): Promise<PaneRef>;
  split(paneId: string, cwd: string, env?: Record<string, string>): Promise<PaneRef>;
  run(paneId: string, commandLine: string): Promise<void>;
  status(paneId: string): Promise<AgentStatus>;
  deliver(paneId: string, text: string, kind?: AgentStatus): Promise<boolean>;
  typeIntoShell(paneId: string, text: string): Promise<boolean>;
  read(paneId: string, lines?: number): Promise<string>;
  close(paneId: string): Promise<void>;
  ownPane(): string | undefined;
  ownWorkspace(): string | undefined;
  /** Whether a `dori send` target is a pane address rather than a role or lane key. */
  isPaneId(target: string): boolean;
  /** Whether a pane in this state may be typed into now; anything else keeps its messages queued. */
  canReceive(status: AgentStatus): boolean;
}

export type MuxSettings = { readonly kind: MuxKind; readonly space?: string };

export function muxFor(settings: MuxSettings, exec: Exec = spawnExec): Mux {
  return settings.kind === "hc" ? new Hc(exec, settings.space) : new Herdr(exec);
}
