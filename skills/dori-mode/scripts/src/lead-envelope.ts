/** The boundary of the lead inbox: an item envelope and a bot name, parsed once before anything is stored. */

export type Envelope = {
  readonly id: string;
  readonly kind: string;
  readonly source: string;
  readonly body: string;
  readonly channel?: string;
  readonly message?: string;
};
/** Input the inbox refuses: the CLI reports it in one line and exits 2. */
export class LeadInboxError extends Error {}

const ID = /^[a-z]+:[A-Za-z0-9:._-]{1,200}$/;
const BOT = /^[a-z][a-z0-9-]{0,31}$/;
/** The bot name becomes a file name, so it is held to a plain lowercase word. */
export const parseBot = (bot: string): string => {
  if (!BOT.test(bot)) throw new LeadInboxError(`invalid bot "${bot}": lowercase letters, digits and -`);
  return bot;
};

const text = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.trim() === "")
    throw new LeadInboxError(`envelope ${field} must be a non-empty string`);
  return value;
};

const optional = (value: unknown, field: string): string | undefined =>
  value === undefined || value === null ? undefined : text(value, field);

export const parseEnvelope = (raw: unknown): Envelope => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new LeadInboxError("envelope must be a JSON object");
  const o = raw as Readonly<Record<string, unknown>>;
  const id = text(o["id"], "id");
  if (!ID.test(id)) throw new LeadInboxError(`invalid id "${id}": must match ${ID.source}`);
  if (typeof o["body"] !== "string") throw new LeadInboxError("envelope body must be a string");
  const channel = optional(o["channel"], "channel");
  const message = optional(o["message"], "message");
  return {
    id,
    kind: text(o["kind"], "kind"),
    source: text(o["source"], "source"),
    body: o["body"],
    ...(channel === undefined ? {} : { channel }),
    ...(message === undefined ? {} : { message }),
  };
};
