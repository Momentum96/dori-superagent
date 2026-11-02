import { mkdirSync, existsSync, appendFileSync, readFileSync, readdirSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Lanes are not kept here: they live in Dori mode's registry (<stateDir>/lanes, see src/harness.ts).
// This store holds what only the harness has: roles, inboxes, rendered prompts, review receipts and the
// duty loop's heartbeat.

export type Role = "lead" | "duty" | "duty-loop";

/** `lane`: the message is about that lane only while it is still working (an [ESCALATE]); flushing drops it after a done claim. */
export type QueuedMessage = { at: number; from: string; text: string; lane?: string };

export type ReviewReceipt = {
  pr: string;
  sha: string;
  verdict: "CLEAR" | "BLOCK";
  model: string;
  at: number;
  summary: string;
};

export type Heartbeat = { at: number; pid: number; intervalMs: number };

export type DutyAgent = { pane: string; version: string };

export class Store {
  // Kept apart from Dori mode's state (~/.dori/state, ~/.dori/config.json).
  constructor(readonly root: string = process.env["DORI_HOME"] ?? join(homedir(), ".dori", "harness")) {
    for (const d of ["inbox", "receipts"]) mkdirSync(join(root, d), { recursive: true });
  }

  private readJson<T>(path: string): T | undefined {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : undefined;
  }

  private writeJson(path: string, value: unknown): void {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
    renameSync(tmp, path);
  }

  roles(): Partial<Record<Role, string>> {
    return this.readJson(join(this.root, "roles.json")) ?? {};
  }

  setRole(role: Role, paneId: string): void {
    this.writeJson(join(this.root, "roles.json"), { ...this.roles(), [role]: paneId });
  }

  private inboxPath(paneId: string): string {
    return join(this.root, "inbox", `${paneId.replaceAll(":", "_").replaceAll("/", "__")}.jsonl`);
  }

  enqueue(paneId: string, msg: QueuedMessage): void {
    appendFileSync(this.inboxPath(paneId), JSON.stringify(msg) + "\n");
  }

  queued(paneId: string): QueuedMessage[] {
    const p = this.inboxPath(paneId);
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as QueuedMessage);
  }

  /** Removes these messages and keeps any that arrived after they were read. */
  dequeue(paneId: string, taken: readonly QueuedMessage[]): void {
    const gone = new Set(taken.map((m) => JSON.stringify(m)));
    const left = this.queued(paneId).filter((m) => !gone.delete(JSON.stringify(m)));
    writeFileSync(this.inboxPath(paneId), left.map((m) => JSON.stringify(m) + "\n").join(""));
  }

  inboxPanes(): string[] {
    return readdirSync(join(this.root, "inbox"))
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.slice(0, -".jsonl".length).replaceAll("__", "/").replaceAll("_", ":"))
      .filter((p) => this.queued(p).length > 0);
  }

  private receiptPath(pr: string, sha: string): string {
    return join(this.root, "receipts", `${pr.replaceAll("/", "__").replace("#", "_")}@${sha}.json`);
  }

  saveReceipt(r: ReviewReceipt): void {
    this.writeJson(this.receiptPath(r.pr, r.sha), r);
  }

  receipt(pr: string, sha: string): ReviewReceipt | undefined {
    return this.readJson(this.receiptPath(pr, sha));
  }

  beat(h: Heartbeat): void {
    this.writeJson(join(this.root, "duty-heartbeat.json"), h);
  }

  /** The agent version (`omo --version`) the duty session in `pane` was started with. */
  setDutyAgent(a: DutyAgent): void {
    this.writeJson(join(this.root, "duty-agent.json"), a);
  }

  dutyAgent(): DutyAgent | undefined {
    return this.readJson(join(this.root, "duty-agent.json"));
  }

  heartbeat(): Heartbeat | undefined {
    return this.readJson(join(this.root, "duty-heartbeat.json"));
  }
}
