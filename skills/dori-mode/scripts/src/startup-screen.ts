// What launch reads on a new lane's screen to tell a failed start from omo's warnings (#202).
import type { Runtimes } from "../../../../src/runtime/registry.ts";
import type { SessionRef } from "../../../../src/runtime/types.ts";

// One space between words, as the agent prints them: the unwrapped read puts back a space hc cut at a wrap, and a looser
// gap would match code such as `rateLimit` or a key such as `ratelimiter`. Three kinds of phrase:
// - ANYWHERE: phrases no healthy screen prints. They match even right after a letter, since a join can glue one onto a
//   printed line that filled the pane (`...okNo API key`).
// - WORD: phrases that are also everyday words or identifiers (`rate limit`, `usage limit`, `quota`, the error codes).
//   No letter, digit or `_` right before (`moderate limits`, `isQuotaExceeded`) or right after beyond a plain ending
//   (`quotaUsed`; `rate limited`, `rate limiter`, `quotas` still count).
// - GLUED: the same words glued onto a pane-wide line, which the WORD rule cannot see. Only as a provider prints them: a
//   capital, then a second word (`...okRate limit exceeded`, `...okQuota exceeded`), which code (`onRateLimit`) is not.
const ANYWHERE =
  /Cannot find module|All fallback models failed|No API key|model_not_available|Session crashed|unknown provider|insufficient_quota/i;
const WORD =
  /(?<![a-z0-9_])(?:quota_?exceeded|rate_?limit_?exceeded|usage limit|rate limit|quota)(?:s|es|ed|er|ing)?(?![a-z0-9_])/i;
const GLUED = /(?<=[a-z0-9])(?:Rate limit|Usage limit|Quota [a-z]+)/;
// omo warns about a user extension it cannot load (`Warning: Failed to load extension "...": ... Cannot find module ...`)
// and starts anyway (#202). Only the warning's own text is removed, never the rest of its line: a row-wrap join can put a
// real failure on the same line. The path may hold the newline of a row the join missed, and a space cut at a wrap may
// be gone, so every gap between words is optional whitespace. Bun goes on with ` imported from <path>` or ` from '<path>'`;
// that path is the extension's own, so it is part of the warning too (a directory named `quota-meter` is not a failure).
// An unquoted path ends at its first script file name (`.js`, `.mjs`, `.ts`, ...) in its LAST segment, never later: a join
// can glue a real failure right after it (`index.jsNo API key`), and a directory such as `anna.tsai/` or `node.js\\` (either
// separator: Bun prints Windows paths with backslashes) is not the file name. It may hold spaces (`/Users/John Doe/...`), not a line break.
const EXTENSION_WARNING =
  /Warning:\s*Failed\s*to\s*load\s*extension\s*"[^"]*":\s*(?:Failed\s*to\s*load\s*extension:\s*)?Cannot\s*find\s*module\s*'[^']*'(?:\s*(?:imported\s*)?from\s*(?:'[^']*'|"[^"]*"|[^\n'"]*?\.[cm]?[jt]sx?(?![\w.-]*[\\/])))?/g;
// A real warning names the extension's full path, so a narrow pane wraps it and `Cannot find module` lands on a later
// row. The startup checks therefore read the screen unwrapped: one line per line the agent printed.
export const startupScreen = (rts: Runtimes, ref: SessionRef): Promise<string> =>
  rts.for(ref).read(ref, 40, { unwrapped: true });
export const startupFailure = (screen: string): string | null => {
  const text = screen.replace(EXTENSION_WARNING, "");
  return (ANYWHERE.exec(text) ?? WORD.exec(text) ?? GLUED.exec(text))?.[0] ?? null;
};
