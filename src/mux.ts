// The terminal multiplexer the harness drives. Two implementations: herdr (`src/herdr.ts`, the default)
// and herdr-core's `hc` (`src/hc.ts`). Pick one with DORI_MUX, or with `mux` in the Dori mode config file.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
  deliver(paneId: string, text: string, kind: AgentStatus): Promise<void>;
  read(paneId: string, lines?: number): Promise<string>;
  close(paneId: string): Promise<void>;
  ownPane(): string | undefined;
  ownWorkspace(): string | undefined;
  /** Whether a `dori send` target is a pane address rather than a role or lane key. */
  isPaneId(target: string): boolean;
}

export type MuxSettings = { readonly kind: MuxKind; readonly space?: string };

type ConfigFile = { mux?: unknown; laneWorkspace?: unknown };

/** DORI_MUX wins; otherwise `mux` (and, for hc, `laneWorkspace`) from DORI_CONFIG or ~/.dori/config.json; else herdr. */
export function muxSettings(env: Record<string, string | undefined> = process.env): MuxSettings {
  const path = env["DORI_CONFIG"] ?? join(homedir(), ".dori", "config.json");
  const file: ConfigFile = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as ConfigFile) : {};
  const kind = env["DORI_MUX"] ?? (typeof file.mux === "string" ? file.mux : "herdr");
  if (kind !== "herdr" && kind !== "hc") throw new Error(`mux must be "herdr" or "hc", got "${kind}"`);
  const space = env["DORI_HC_SPACE"] ?? (typeof file.laneWorkspace === "string" && file.laneWorkspace ? file.laneWorkspace : undefined);
  return space ? { kind, space } : { kind };
}

export function muxFor(settings: MuxSettings = muxSettings(), exec: Exec = spawnExec): Mux {
  return settings.kind === "hc" ? new Hc(exec, settings.space) : new Herdr(exec);
}
