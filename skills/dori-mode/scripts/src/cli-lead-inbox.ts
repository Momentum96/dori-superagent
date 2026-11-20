/** dori lead-inbox put|list|stats|import-spool: the lead's inbox from the command line. Refused input exits 2. */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { type Cli, type Command, die } from "./cli-context.ts";
import { LeadInboxError, parseEnvelope } from "./lead-envelope.ts";
import { isLeadItemState, LeadInbox } from "./lead-inbox.ts";
import { type Clock, realClock } from "./run.ts";

const SPOOL_EVERY_MS = 2_000;

type SpoolResult = {
  readonly file: string;
  readonly outcome: "inserted" | "duplicate" | "rejected";
  readonly why?: string;
};

/**
 * One pass over a spool directory, oldest *.json first (a writer drops <name>.json.tmp and renames it, so a file in
 * flight is never read). A file is deleted only after its put answered; one that fails validation moves to rejected/.
 * Any other failure (the database busy past its timeout) stops the pass with that file and the later ones kept, so
 * a later file never takes an earlier seq.
 */
export const importSpool = (inbox: LeadInbox, dir: string): SpoolResult[] => {
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".json"))
    .map((d) => ({ name: d.name, mtime: statSync(join(dir, d.name)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));
  const results: SpoolResult[] = [];
  for (const { name } of files) {
    const path = join(dir, name);
    let outcome: "inserted" | "duplicate";
    try {
      outcome = inbox.put(parseEnvelope(JSON.parse(readFileSync(path, "utf8"))));
    } catch (e) {
      if (!(e instanceof LeadInboxError || e instanceof SyntaxError)) throw e;
      mkdirSync(join(dir, "rejected"), { recursive: true });
      renameSync(path, join(dir, "rejected", name));
      results.push({ file: name, outcome: "rejected", why: e.message });
      continue;
    }
    rmSync(path, { force: true });
    results.push({ file: name, outcome });
  }
  return results;
};

const spoolLoop = async (inbox: LeadInbox, dir: string, clock: Clock, loop: boolean): Promise<void> => {
  for (;;) {
    try {
      for (const r of importSpool(inbox, dir)) console.log(`SPOOL ${r.outcome} ${r.file}${r.why ? ` ${r.why}` : ""}`);
    } catch (e) {
      if (!loop) throw e;
      console.log(`WARN spool ${e instanceof Error ? e.message : String(e)}`.slice(0, 300));
    }
    if (!loop) return;
    await clock.sleep(SPOOL_EVERY_MS);
  }
};

const put = async ({ values, need }: Cli, inbox: LeadInbox) => {
  const stdin = await Bun.stdin.text();
  const envelope = values["envelope"]
    ? (() => {
        try {
          return JSON.parse(stdin) as unknown;
        } catch {
          throw new LeadInboxError("--envelope wants one JSON object on stdin");
        }
      })()
    : { id: need("id"), kind: need("kind"), source: need("source"), body: stdin };
  console.log(inbox.put(parseEnvelope(envelope)));
};

const leadInbox: Command = async (cli) => {
  const { key, values, opt, need, config } = cli;
  let inbox: LeadInbox | undefined;
  try {
    inbox = new LeadInbox(config.stateDir, need("bot"), realClock);
    switch (key) {
      case "put":
        return await put(cli, inbox);
      case "list": {
        const state = opt("state");
        if (state !== undefined && !isLeadItemState(state))
          throw new LeadInboxError("--state must be queued, sent, ambiguous or done");
        const items = inbox.list(state);
        if (values["json"]) console.log(JSON.stringify(items, null, 2));
        else for (const i of items) console.log(`${i.seq} ${i.state} ${i.id} ${i.kind} ${i.source}`);
        return;
      }
      case "stats": {
        const stats = inbox.stats();
        console.log(
          values["json"]
            ? JSON.stringify(stats)
            : `queued=${stats.queued} sent=${stats.sent} ambiguous=${stats.ambiguous} done=${stats.done}`,
        );
        return;
      }
      case "import-spool": {
        // --loop is a bare flag here; a value means it swallowed the next flag (`--loop --bot omo`).
        if (typeof values["loop"] === "string") throw new LeadInboxError("--loop takes no value; put it last");
        const spool = need("spool");
        if (!existsSync(spool)) throw new LeadInboxError(`no spool directory ${spool}`);
        return await spoolLoop(inbox, spool, realClock, values["loop"] !== undefined);
      }
      default:
        die("lead-inbox needs put, list, stats or import-spool");
    }
  } catch (e) {
    if (e instanceof LeadInboxError) die(e.message, 2);
    throw e;
  } finally {
    inbox?.close();
  }
};

export const leadInboxCommands: Readonly<Record<string, Command>> = { "lead-inbox": leadInbox };
