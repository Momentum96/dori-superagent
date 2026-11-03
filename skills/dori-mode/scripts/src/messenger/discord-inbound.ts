import { mkdir, open as openFile, rename } from "node:fs/promises";
import { dirname } from "node:path";

import type { Discord } from "./discord.ts";
import type { Timers } from "./typing.ts";

export type DiscordMessage = {
  readonly id: string;
  readonly channel_id: string;
  readonly author: { readonly id: string; readonly bot?: boolean };
  readonly content: string;
  readonly guild_id?: string;
  readonly attachments?: unknown[];
  readonly message_reference?: unknown;
  readonly referenced_message?: unknown;
  readonly message_snapshots?: unknown;
  readonly mentions?: readonly { readonly id: string }[];
};
export type DiscordInboundState = { scope: string; seen: string[]; channels: string[]; after?: string };
export type DiscordInboundTransport = {
  getChannel(id: string): Promise<{ readonly type: number; readonly parent_id?: string | null }>;
  getMessages(id: string, limit: number): Promise<DiscordMessage[]>;
  activeThreads(): Promise<{ readonly id: string; readonly parent_id?: string | null; readonly type: number }[]>;
};

const THREAD_TYPES = [10, 11, 12];
const bySnowflake = (a: DiscordMessage, b: DiscordMessage) => (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);

export class DiscordInbound {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    readonly channel: string,
    readonly owner: string,
    readonly state: DiscordInboundState,
    private readonly transport: DiscordInboundTransport,
    private readonly emit: (line: string) => Promise<void>,
    private readonly save: (state: DiscordInboundState) => Promise<void>,
  ) {
    if (state.scope !== `${channel}:${owner}`) throw new Error("state file belongs to another channel or owner");
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.queue.then(work);
    this.queue = next;
    return next;
  }

  accept(message: DiscordMessage): Promise<void> {
    return this.enqueue(() => this.deliver(message));
  }

  private async deliver(message: DiscordMessage): Promise<void> {
    if (message.author.bot || message.author.id !== this.owner || this.state.seen.includes(message.id)) return;
    if (this.state.after && BigInt(message.id) <= BigInt(this.state.after)) return;
    if (message.channel_id !== this.channel) {
      const channel = await this.transport.getChannel(message.channel_id);
      if (!THREAD_TYPES.includes(channel.type) || channel.parent_id !== this.channel) return;
    }
    await this.emit(
      JSON.stringify({
        event: "DORI_INBOUND",
        messageId: message.id,
        channelId: message.channel_id,
        authorId: message.author.id,
        guildId: message.guild_id,
        content: message.content,
        mentions: (message.mentions ?? []).map((u) => u.id),
        attachments: message.attachments ?? [],
        message_reference: message.message_reference,
        referenced_message: message.referenced_message,
        message_snapshots: message.message_snapshots,
      }),
    );
    if (!this.state.channels.includes(message.channel_id)) this.state.channels.push(message.channel_id);
    this.state.seen.push(message.id);
    this.state.seen = this.state.seen.slice(-10_000);
    await this.save(this.state);
  }

  /** Reads the newest 100 messages of the main channel, remembered threads and active threads. A thread that cannot be read (archived, deleted, no access) is forgotten and skipped; only the main channel failing fails recovery. */
  recover(): Promise<void> {
    return this.enqueue(async () => {
      const active = (await this.transport.activeThreads()).filter((t) => t.parent_id === this.channel);
      const channels = new Set([this.channel, ...this.state.channels, ...active.map((t) => t.id)]);
      for (const channel of channels) {
        let messages: DiscordMessage[];
        try {
          messages = await this.transport.getMessages(channel, 100);
        } catch {
          if (channel === this.channel) throw new Error("main channel unavailable");
          this.state.channels = this.state.channels.filter((id) => id !== channel);
          await this.save(this.state);
          continue;
        }
        for (const message of [...messages].sort(bySnowflake)) await this.deliver(message);
      }
    });
  }

  drain(): Promise<void> {
    return this.queue;
  }
}

export type InboundSocket = { send(data: string): void; close(): void; onMessage(cb: (data: string) => void): void; onClose(cb: (code: number) => void): void };
export type GatewayTimers = Timers & { readonly setTimeout: (cb: () => void, ms: number) => unknown };
export type GatewayEvents = { connected: []; message_create: [DiscordMessage]; disconnected: []; error: [] };

export const DISCORD_INTENTS_INBOUND = (1 << 9) | (1 << 15); // GUILD_MESSAGES | MESSAGE_CONTENT
/** Close codes that a reconnect cannot fix: bad token, bad shard, invalid or disallowed intents. */
const FATAL_CLOSE = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

export class DiscordGatewayListener {
  private readonly handlers: { [K in keyof GatewayEvents]: ((...args: GatewayEvents[K]) => void)[] } = { connected: [], message_create: [], disconnected: [], error: [] };
  private socket: InboundSocket | undefined;
  private beat: unknown;
  private stopped = false;

  constructor(
    private readonly open: () => InboundSocket,
    private readonly token: string,
    private readonly timers: GatewayTimers,
    private readonly reconnectMs = 5_000,
  ) {}

  on<K extends keyof GatewayEvents>(event: K, cb: (...args: GatewayEvents[K]) => void): void {
    this.handlers[event].push(cb);
  }

  private fire<K extends keyof GatewayEvents>(event: K, ...args: GatewayEvents[K]): void {
    for (const cb of this.handlers[event]) cb(...args);
  }

  private connect(): void {
    const ws = this.open();
    this.socket = ws;
    let seq: number | null = null;
    let acked = true;
    ws.onMessage((raw) => {
      const m = JSON.parse(raw) as { op: number; s?: number | null; t?: string | null; d?: unknown };
      if (typeof m.s === "number") seq = m.s;
      if (m.op === 10) {
        const interval = (m.d as { heartbeat_interval?: number } | undefined)?.heartbeat_interval ?? 41_250;
        this.beat = this.timers.setInterval(() => {
          // No ack since the last beat: the connection is a zombie. Closing it leads to a reconnect.
          if (!acked) return ws.close();
          acked = false;
          ws.send(JSON.stringify({ op: 1, d: seq }));
        }, interval);
        ws.send(JSON.stringify({ op: 2, d: { token: this.token, intents: DISCORD_INTENTS_INBOUND, properties: { os: process.platform, browser: "dori", device: "dori" } } }));
      } else if (m.op === 11) acked = true;
      else if (m.op === 1) ws.send(JSON.stringify({ op: 1, d: seq }));
      else if (m.op === 7 || m.op === 9) ws.close();
      else if (m.op === 0 && m.t === "READY") this.fire("connected");
      else if (m.op === 0 && m.t === "MESSAGE_CREATE") this.fire("message_create", m.d as DiscordMessage);
    });
    ws.onClose((code) => {
      if (this.beat !== undefined) this.timers.clearInterval(this.beat);
      this.beat = undefined;
      if (this.stopped || this.socket !== ws) return;
      if (FATAL_CLOSE.has(code)) return this.fire("error");
      this.fire("disconnected");
      this.timers.setTimeout(() => {
        if (!this.stopped) this.connect();
      }, this.reconnectMs);
    });
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.beat !== undefined) this.timers.clearInterval(this.beat);
    this.beat = undefined;
    this.socket?.close();
  }
}

export type InboundListener = {
  on<K extends keyof GatewayEvents>(event: K, cb: (...args: GatewayEvents[K]) => void): unknown;
  start(): Promise<void>;
  stop(): void;
};

// Raw errors can carry request details, so only a phase name is reported.
export const watchDiscordInbound = async (listener: InboundListener, inbound: DiscordInbound, signal: AbortSignal, report: (phase: string) => void): Promise<void> => {
  let finish!: () => void;
  let failed = false;
  const stopped = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const stop = () => {
    listener.stop();
    finish();
  };
  const fail = (phase: string) => {
    failed = true;
    report(phase);
    stop();
  };
  listener.on("connected", () => {
    report("connected");
    void inbound.recover().catch(() => fail("recovery failed"));
  });
  listener.on("message_create", (message) => void inbound.accept(message).catch(() => fail("delivery failed")));
  listener.on("disconnected", () => report("disconnected; reconnecting"));
  listener.on("error", () => fail("gateway failed"));
  signal.addEventListener("abort", stop, { once: true });
  try {
    if (signal.aborted) return;
    try {
      await listener.start();
    } catch {
      if (!signal.aborted) fail("gateway start failed");
    }
    await stopped;
    await inbound.drain();
    if (failed) throw new Error("watch failed");
  } finally {
    listener.stop();
    signal.removeEventListener("abort", stop);
  }
};

export const discordInboundTransport = (discord: Discord, guild: string): DiscordInboundTransport => ({
  getChannel: (id) => discord.call("GET", `/channels/${id}`),
  getMessages: (id, limit) => discord.call("GET", `/channels/${id}/messages?limit=${limit}`),
  activeThreads: async () => (await discord.call<{ threads?: { id: string; parent_id?: string | null; type: number }[] }>("GET", `/guilds/${guild}/threads/active`)).threads ?? [],
});

export const loadInboundState = async (file: string, channel: string, owner: string): Promise<DiscordInboundState> =>
  (await Bun.file(file).exists()) ? ((await Bun.file(file).json()) as DiscordInboundState) : { scope: `${channel}:${owner}`, seen: [], channels: [] };

export const saveInboundState = async (file: string, state: DiscordInboundState): Promise<void> => {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  const handle = await openFile(temporary, "w", 0o600);
  try {
    await handle.writeFile(JSON.stringify(state));
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
};
