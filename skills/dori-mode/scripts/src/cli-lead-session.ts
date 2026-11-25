/** dori lead open|replace|status: name, replace and read the bot's lead session. Refused input exits 2, a lead state that does not allow the request 3. */
import { resolve } from "node:path";

import type { Exec } from "../../../../src/runtime/exec.ts";
import { type Cli, type Command, die, engineOption } from "./cli-context.ts";
import { bounded } from "./cli-lead-pump.ts";
import { fill } from "./config.ts";
import { LeadInboxError, parseBot } from "./lead-envelope.ts";
import { LeadSessionError, type LeadSessionDeps, leadStatus, openLead, replaceLead } from "./lead-session.ts";
import { LeadStateError } from "./lead-state.ts";

const depsOf = ({ config, deps }: Cli): LeadSessionDeps => {
  const run = bounded(deps.run);
  const exec: Exec = async (cmd, argv) => {
    const r = await run([cmd, ...argv]);
    return { code: r.code, stdout: r.out, stderr: r.err };
  };
  const template = config.hooks.leadAlert;
  return {
    stateDir: config.stateDir,
    exec,
    clock: deps.clock,
    alert: async (text) => {
      console.error(`ALERT ${text}`);
      if (template === undefined) return;
      const r = await run(fill(template, { text }));
      if (r.code !== 0) console.error(`WARN hooks.leadAlert failed (${r.code}): ${r.err}`.slice(0, 300));
    },
  };
};

const absolute = (path: string | undefined): string | undefined => (path === undefined ? undefined : resolve(path));

const lead: Command = async (cli) => {
  const { key, opt, need, values } = cli;
  try {
    const bot = parseBot(need("bot"));
    switch (key) {
      case "open": {
        const runtime = opt("runtime") ?? "omo-host";
        if (runtime !== "omo-host" && runtime !== "hc")
          throw new LeadSessionError("--runtime must be omo-host or hc", 2);
        const model = opt("model");
        const rulesFile = absolute(opt("rules"));
        const pane = opt("pane");
        const opened = await openLead(depsOf(cli), {
          bot,
          cwd: resolve(need("cwd")),
          runtime,
          engine: engineOption(opt("engine")),
          ...(model === undefined ? {} : { model }),
          ...(rulesFile === undefined ? {} : { rulesFile }),
          ...(pane === undefined ? {} : { pane }),
        });
        console.log(`LEAD_OPEN ${bot} ${opened.runtime} ${opened.sessionId} generation=${opened.generation}`);
        return;
      }
      case "replace": {
        const model = opt("model");
        const r = await replaceLead(depsOf(cli), {
          bot,
          rulesFile: resolve(need("rules")),
          engine: engineOption(opt("engine")),
          ...(model === undefined ? {} : { model }),
        });
        for (const id of r.orphans) console.log(`ORPHAN ${id} (open, named like this lead, not in lead.json)`);
        if (r.closeFailure) console.log(`CLOSE_REFUSED ${r.retired} ${r.closeFailure.answer}`);
        console.log(`LEAD_REPLACED ${bot} ${r.retired} -> ${r.lead.sessionId} generation=${r.lead.generation}`);
        return;
      }
      case "status": {
        const state = await leadStatus(cli.config.stateDir, bot);
        console.log(
          values["json"]
            ? JSON.stringify(state)
            : `${state.bot} ${state.state} ${state.runtime} ${state.sessionId} generation=${state.generation}${state.engine === "mhc" ? " engine=mhc" : ""}`,
        );
        return;
      }
      default:
        die("lead needs open, replace or status");
    }
  } catch (e) {
    if (e instanceof LeadSessionError) die(e.message, e.code);
    if (e instanceof LeadStateError || e instanceof LeadInboxError) die(e.message, 2);
    throw e;
  }
};

export const leadSessionCommands: Readonly<Record<string, Command>> = { lead };
