// What launch reads on a new lane's screen to tell a failed start from omo's warnings (#202).
import type { Runtimes } from "../../../../src/runtime/registry.ts";
import type { SessionRef } from "../../../../src/runtime/types.ts";

/**
 * Every phrase that means a lane failed to start, one row each (#202), in three kinds:
 * - `anywhere`: text no healthy screen prints (omo's own failure lines, provider messages). It matches even glued onto
 *   the end of a pane-wide line by the unwrapped read (`...okNo API key`).
 * - `word`: a phrase that names a failure, not a topic (`rate limit reached`, never bare `rate limit`, `quota` or a
 *   component such as `rate limiter`). It must stand alone; see `standsAlone`. Its gaps are single spaces as printed
 *   (the unwrapped read puts back a space hc cut at a wrap), never `-`, so a kebab-case lane key or brief file name
 *   such as `fix-rate-limit-error` is not one.
 * - `value`: an error code (`insufficient_quota`, `QUOTA_EXCEEDED`), counted only where it is a value: after `error`,
 *   `code`, `type` or `status` and a `:` or `=` (`"type":"rate_limit_error"`, `code=quotaExceeded`). The same code
 *   in source (`case 'rate_limit_error':`, `instanceof RateLimitError`, `X === 'RESOURCE_EXHAUSTED'`) is not.
 * test/startup-screen.test.ts holds the corpus: real provider and tool output with its source, rule cases, and code
 * and prose that must report nothing.
 */
type Kind = "anywhere" | "word" | "value";
const PHRASES: readonly (readonly [Kind, string])[] = [
  ["anywhere", "Cannot find module"],
  ["anywhere", "All fallback models failed"],
  ["anywhere", "No API key"],
  ["anywhere", "model_not_available"],
  ["anywhere", "Session crashed"],
  ["anywhere", "unknown provider"],
  ["anywhere", "(?:429|Error:|HTTP \\d\\.?\\d?) Too Many Requests"],
  ["anywhere", "RESOURCE_EXHAUSTED: Resource exhausted"],
  ["anywhere", "429 status code \\(no body\\)"],
  ["anywhere", "RateLimitError: 4\\d\\d"],
  ["anywhere", "Resource has been exhausted"],
  ["anywhere", "would exceed your account's rate limit"],
  ["anywhere", "exceeded your current quota"],
  ["word", "rate limit(?:s)? (?:exceeded|reached|hit)"],
  ["word", "rate limited"],
  ["word", "rate-limit (?:exceeded|reached)"],
  ["word", "usage limit(?:s)? (?:exceeded|reached|hit)"],
  ["word", "(?:reached|hit) your usage limit"],
  ["word", "quota(?:s)? (?:exceeded|exhausted|reached|hit)"],
  ["value", "insufficient_quota|rate_limit_error|resource_exhausted|quota_?exceeded|rate_?limit_?exceeded"],
];
const PATTERNS = PHRASES.map(([kind, source]) => ({ kind, re: new RegExp(source, "gi") }));
/** What touching a word match makes it part of something else: a word, a path, a kebab-case name, a file name. */
const JOINS = /[a-z0-9_/\\.-]/i;
/**
 * A `word` match stands alone when nothing in JOINS touches its end (a `.` only when a word goes on: `reached.` ends a
 * sentence, `limited.md` is a file), and nothing touches its start, except when a join glued it onto a pane-wide line,
 * whatever that line ended in (`ok`, `....`, `----`, a path). Then it must read as printed text: it starts with a
 * capital and has a space (`...okRate limit reached`), which camelCase (`onRateLimitExceeded`) and lower-case names
 * (`fix-rate-limit-error`) never are.
 */
const standsAlone = (text: string, at: number, found: string): boolean => {
  const after = text[at + found.length] ?? "";
  if (JOINS.test(after) && !(after === "." && !/[a-z0-9_]/i.test(text[at + found.length + 1] ?? ""))) return false;
  const before = text[at - 1] ?? "";
  if (!JOINS.test(before)) return true;
  return /^[A-Z]/.test(found) && found.includes(" ");
};
/**
 * A `value` match counts only as the value of an `error`, `code`, `type` or `status` field as logs and JSON print it:
 * `key: VALUE`, `"key":"VALUE"` or `key=VALUE` with no spaces. The key is a whole lower-case word (`errorType` is
 * not one), and a `= '`, `: '` or `===` is source code (`const code = 'insufficient_quota'`), never a value.
 */
const VALUE_KEY = /(?:^|[^A-Za-z0-9_])"?(?:error|code|type|status)"?(?::\s*"?|=)$/;
const isValue = (text: string, at: number, found: string): boolean =>
  VALUE_KEY.test(text.slice(Math.max(0, at - 24), at)) && !/[a-z0-9_]/i.test(text[at + found.length] ?? "");
const counts = (kind: Kind, text: string, at: number, found: string): boolean =>
  kind === "anywhere" || (kind === "word" ? standsAlone(text, at, found) : isValue(text, at, found));
const firstFailure = (text: string): string | null => {
  let first: { at: number; found: string } | undefined;
  for (const { kind, re } of PATTERNS) {
    for (const m of text.matchAll(re)) {
      if (!counts(kind, text, m.index, m[0])) continue;
      if (!first || m.index < first.at) first = { at: m.index, found: m[0] };
      break;
    }
  }
  return first?.found ?? null;
};
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
  return firstFailure(screen.replace(EXTENSION_WARNING, ""));
};
