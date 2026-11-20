/**
 * What the lead pump sends and how it finds it again. One line group per inbox item: a `[INBOX#<id>]` header line
 * (kind, source, replayed) and the body with every line behind `  | `, so an item body is data: no body line can
 * start a header, and a `[INBOX#...]` written inside a body never reads as that item's delivery token.
 */
import type { LeadItem } from "./lead-inbox.ts";

/** The whole text is held to 8 KiB: it is passed as one argument (an `@file` argument would arrive as literal text). */
export const TEXT_CAP = 8192;
export const NOT_AN_ANSWER = "[INBOX] 아래는 질문의 답이 아님";
export const WAKE = "[INBOX] 대기 항목 확인";

const BODY = "  | ";
const bytes = (text: string): number => Buffer.byteLength(text);
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();
const header = (item: LeadItem, replayed: boolean): string =>
  `[INBOX#${item.id}] kind=${oneLine(item.kind)} source=${oneLine(item.source)}${replayed ? " replayed=true" : ""}`;
const bodyLines = (body: string): string =>
  body
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => `${BODY}${line}`)
    .join("\n");

const cut = (body: string, room: number): string =>
  Buffer.from(body)
    .subarray(0, Math.max(room, 0))
    .toString()
    .replace(/\uFFFD+$/, "");

export type Rendered = { readonly text: string; readonly items: readonly LeadItem[] };

/**
 * The batch as one text under TEXT_CAP. Items that do not fit stay out (they go in the next batch); the first item is
 * always in, its body cut short with a note naming where the full body is when it alone is over the cap. `replayed`:
 * the item went to an older lead generation and is sent again to this one.
 */
export const renderBatch = (
  batch: readonly LeadItem[],
  opts: { readonly bot: string; readonly generation: number; readonly notAnAnswer: boolean },
): Rendered => {
  const parts: string[] = opts.notAnAnswer ? [NOT_AN_ANSWER] : [];
  const items: LeadItem[] = [];
  for (const item of batch) {
    const head = header(item, item.generation !== null && item.generation < opts.generation);
    const whole = `${head}\n${bodyLines(item.body)}`;
    const used = bytes(parts.join("\n")) + (parts.length > 0 ? 1 : 0);
    if (used + bytes(whole) <= TEXT_CAP) {
      parts.push(whole);
      items.push(item);
      continue;
    }
    if (items.length > 0) break;
    const note = `${BODY}... (cut: the full body is in dori lead-inbox list --bot ${opts.bot} --json, id ${item.id})`;
    let room = TEXT_CAP - used - bytes(`${head}\n\n${note}`);
    let shown = bodyLines(cut(item.body, room));
    while (bytes(shown) > room && room > 0) {
      room -= bytes(shown) - room;
      shown = bodyLines(cut(item.body, room));
    }
    parts.push(`${head}\n${shown}\n${note}`);
    items.push(item);
    break;
  }
  return { text: parts.join("\n"), items };
};

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The ids whose delivery token starts a line of `text` (a transcript user message, or a terminal screen where the
 * line may carry the prompt mark `> ` or `❯ `). A token inside a body line never counts: it sits behind `  | `.
 */
const tokensIn = (text: string, ids: readonly string[]): Set<string> =>
  new Set(ids.filter((id) => new RegExp(`(?:^|\\n)(?:[>❯] ?)?\\[INBOX#${escapeRegex(id)}\\] `).test(text)));

/** The text of every user message in a `read --messages` answer; undefined when the JSON did not arrive whole. */
const userTexts = (raw: string): string | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim().split("\n").at(-1) ?? "");
  } catch {
    return undefined;
  }
  const messages = (parsed as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages)) return undefined;
  return messages
    .filter((m: { role?: unknown }) => m?.role === "user")
    .flatMap((m: { content?: unknown }) =>
      typeof m.content === "string"
        ? [m.content]
        : Array.isArray(m.content)
          ? m.content.flatMap((p: { type?: unknown; text?: unknown }) =>
              p?.type === "text" && typeof p.text === "string" ? [p.text] : [],
            )
          : [],
    )
    .join("\n");
};

const TAIL = 200;

/**
 * Delivery tokens of `ids` in the lead's transcript: a host session's `read --messages`, asking for half as many
 * messages until the JSON arrives whole; any other runtime's screen.
 */
export const transcriptTokens = async (
  hosted: boolean,
  ids: readonly string[],
  read: { readonly screen: () => Promise<string>; readonly messages: (tail: number) => Promise<string> },
): Promise<Set<string>> => {
  if (!hosted) return tokensIn(await read.screen(), ids);
  for (let n = TAIL; n >= 1; n = Math.floor(n / 2)) {
    const text = userTexts(await read.messages(n));
    if (text !== undefined) return tokensIn(text, ids);
  }
  return new Set();
};

export type HostStatus = { readonly ready: boolean; readonly pid: number | null; readonly startedAt: string | null };

/** `omo host status --json`: ready only when reachable with lifecycle ready; the start time as ISO when it parses. */
export const parseHostStatus = (raw: string): HostStatus => {
  let o: Record<string, unknown> = {};
  try {
    o = JSON.parse(raw.trim().split("\n").at(-1) ?? "") as Record<string, unknown>;
  } catch {
    return { ready: false, pid: null, startedAt: null };
  }
  const started = typeof o["processStartTime"] === "string" ? o["processStartTime"] : null;
  const ms = started === null ? Number.NaN : Date.parse(started);
  return {
    ready: o["reachable"] === true && o["lifecycle"] === "ready",
    pid: typeof o["pid"] === "number" ? o["pid"] : null,
    startedAt: Number.isNaN(ms) ? started : new Date(ms).toISOString(),
  };
};

/** The part of an inbox id taken from a host start time (`sys:host-restart:<startedAt>`). */
export const idPart = (text: string): string => text.replace(/[^A-Za-z0-9:._-]/g, "-").slice(0, 120);
