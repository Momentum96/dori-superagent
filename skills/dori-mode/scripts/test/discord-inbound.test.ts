import { expect, test } from "bun:test";

import { DiscordGatewayListener, DiscordInbound, type DiscordInboundState, type DiscordInboundTransport, type DiscordMessage, type InboundSocket, watchDiscordInbound } from "../src/messenger/discord-inbound.ts";
import { MessengerError } from "../src/messenger/http.ts";

const MAIN = "1";
const OWNER = "9";
const message = (id: string, channel_id = MAIN, author: DiscordMessage["author"] = { id: OWNER }): DiscordMessage => ({ id, channel_id, author, content: `m${id}` });

const fixture = (state: DiscordInboundState = { scope: `${MAIN}:${OWNER}`, seen: [], channels: [] }) => {
  const lines: string[] = [];
  const saved: DiscordInboundState[] = [];
  const history: Record<string, DiscordMessage[]> = {};
  const unreadable = new Set<string>();
  const transient = new Set<string>();
  const noMetadata = new Set<string>();
  const failing = { activeThreads: false };
  const transport: DiscordInboundTransport = {
    getChannel: async (id) => {
      if (noMetadata.has(id)) throw new MessengerError(`discord GET /channels/${id}: 403 {"message": "Missing Access"}`, 403);
      return { type: ["2", "3", "4", "5"].includes(id) ? 11 : 0, parent_id: id === "3" ? "other" : MAIN };
    },
    // History is newest first, like the Discord API.
    getMessages: async (id, limit, before) => {
      if (unreadable.has(id)) throw new MessengerError(`discord GET /channels/${id}/messages: 404 {"message": "Unknown Channel"}`, 404);
      if (transient.has(id)) throw new MessengerError(`discord GET /channels/${id}/messages: 503 upstream`, 503);
      return (history[id] ?? []).filter((m) => before === undefined || BigInt(m.id) < BigInt(before)).slice(0, limit);
    },
    activeThreads: async () => {
      if (failing.activeThreads) throw new MessengerError("discord GET /guilds/g/threads/active: 500 oops", 500);
      return [{ id: "2", type: 11, parent_id: MAIN }, { id: "3", type: 11, parent_id: "other" }];
    },
  };
  const inbound = new DiscordInbound(MAIN, OWNER, state, transport, async (line) => { lines.push(line); }, async (s) => { saved.push(structuredClone(s)); });
  const ids = () => lines.map((l) => (JSON.parse(l) as { messageId: string }).messageId);
  return { inbound, lines, saved, history, unreadable, transient, noMetadata, failing, ids, state };
};

test("recovery skips an archived or deleted remembered thread, forgets it, and still recovers every other channel", async () => {
  const f = fixture({ scope: `${MAIN}:${OWNER}`, seen: [], channels: ["4", "5"] });
  f.unreadable.add("4");
  f.history[MAIN] = [message("20")];
  f.history["2"] = [message("21", "2")];
  f.history["5"] = [message("22", "5")];
  await f.inbound.recover();
  expect(f.ids().sort()).toEqual(["20", "21", "22"]);
  expect(f.state.channels).not.toContain("4");
  expect(f.saved.at(-1)?.channels).not.toContain("4");
  expect(f.state.channels).toContain("5");
});

test("recovery still reads the main and remembered channels when the active-thread list fails", async () => {
  const f = fixture({ scope: `${MAIN}:${OWNER}`, seen: [], channels: ["5"] });
  f.failing.activeThreads = true;
  f.history[MAIN] = [message("20")];
  f.history["5"] = [message("22", "5")];
  await f.inbound.recover();
  expect(f.ids().sort()).toEqual(["20", "22"]);
});

test("recovery skips a thread whose metadata cannot be read and recovers every other channel", async () => {
  const f = fixture({ scope: `${MAIN}:${OWNER}`, seen: [], channels: ["5"] });
  f.noMetadata.add("5");
  f.history[MAIN] = [message("20")];
  f.history["2"] = [message("21", "2")];
  f.history["5"] = [message("22", "5")];
  await f.inbound.recover();
  expect(f.ids().sort()).toEqual(["20", "21"]);
  expect(f.state.channels).not.toContain("5");
});

test("a transient thread read failure keeps the thread, so the next recovery still reads it", async () => {
  const f = fixture({ scope: `${MAIN}:${OWNER}`, seen: [], channels: ["5"] });
  f.transient.add("5");
  f.history["5"] = [message("22", "5")];
  await f.inbound.recover();
  expect(f.ids()).toEqual([]);
  expect(f.state.channels).toContain("5");
  f.transient.delete("5");
  await f.inbound.recover();
  expect(f.ids()).toEqual(["22"]);
});

test("recovery pages back to the last delivered message, so more than 100 messages of downtime are not lost", async () => {
  const f = fixture({ scope: `${MAIN}:${OWNER}`, seen: ["100"], channels: [] });
  f.history[MAIN] = Array.from({ length: 151 }, (_, i) => message(String(250 - i)));
  await f.inbound.recover();
  expect(f.ids()).toEqual(Array.from({ length: 150 }, (_, i) => String(101 + i)).sort((a, b) => Number(a) - Number(b)));
});

test("recovery fails when the main channel cannot be read, so the supervisor restarts the watcher", async () => {
  const f = fixture();
  f.unreadable.add(MAIN);
  f.history["2"] = [message("21", "2")];
  await expect(f.inbound.recover()).rejects.toThrow("main channel unavailable");
});

test("only the owner's human messages in the channel or its own threads are emitted, each once across recovery, live events and a restart", async () => {
  const f = fixture();
  await f.inbound.accept(message("10", MAIN, { id: "8" }));
  await f.inbound.accept(message("11", MAIN, { id: OWNER, bot: true }));
  await f.inbound.accept(message("12", "3"));
  await f.inbound.accept(message("16", "7"));
  f.history[MAIN] = [message("14"), message("13")];
  await Promise.all([f.inbound.recover(), f.inbound.accept(message("14")), f.inbound.accept(message("13"))]);
  expect(f.ids()).toEqual(["13", "14"]);
  expect(JSON.parse(f.lines[0] ?? "{}")).toMatchObject({ event: "DORI_INBOUND", channelId: MAIN, authorId: OWNER, content: "m13" });
  const restarted = fixture(f.saved.at(-1));
  restarted.history[MAIN] = [message("15"), message("14"), message("13")];
  await restarted.inbound.recover();
  expect(restarted.ids()).toEqual(["15"]);
});

test("the gateway recovers on every session, identifies on every reconnect, reconnects after a missed heartbeat ack or a drop and stops on a fatal close", async () => {
  const f = fixture();
  f.history[MAIN] = [message("30")];
  const sockets: { sent: string[]; closed: boolean; push: (m: object) => void; drop: (code: number) => void }[] = [];
  const open = (): InboundSocket => {
    let onMessage: (d: string) => void = () => {};
    let onClose: (c: number) => void = () => {};
    const s = { sent: [] as string[], closed: false, push: (m: object) => onMessage(JSON.stringify(m)), drop: (c: number) => onClose(c) };
    sockets.push(s);
    return { send: (d) => s.sent.push(d), close: () => { s.closed = true; onClose(1000); }, onMessage: (cb) => { onMessage = cb; }, onClose: (cb) => { onClose = cb; } };
  };
  const beats: (() => void)[] = [];
  const timers = { setInterval: (cb: () => void) => beats.push(cb), clearInterval: () => {}, setTimeout: (cb: () => void) => cb() };
  const handshake = (i: number) => {
    sockets[i]?.push({ op: 10, d: { heartbeat_interval: 1000 } });
    expect(JSON.parse(sockets[i]?.sent[0] ?? "{}")).toMatchObject({ op: 2, d: { token: "tok" } });
    sockets[i]?.push({ op: 0, s: 1, t: "READY", d: {} });
  };
  const listener = new DiscordGatewayListener(open, "tok", timers);
  const phases: string[] = [];
  const done = watchDiscordInbound(listener, f.inbound, new AbortController().signal, (p) => phases.push(p));
  handshake(0);
  sockets[0]?.push({ op: 0, s: 2, t: "MESSAGE_CREATE", d: message("31") });
  await f.inbound.drain();
  expect(f.ids()).toEqual(["30", "31"]);
  beats[0]?.();
  expect(JSON.parse(sockets[0]?.sent[1] ?? "{}")).toEqual({ op: 1, d: 2 });
  sockets[0]?.push({ op: 11 });
  beats[0]?.();
  expect(sockets[0]?.closed).toBe(false);
  f.history[MAIN] = [message("32"), message("31"), message("30")];
  beats[0]?.();
  expect(sockets[0]?.closed).toBe(true);
  expect(sockets).toHaveLength(2);
  handshake(1);
  await f.inbound.drain();
  expect(f.ids()).toEqual(["30", "31", "32"]);
  sockets[1]?.drop(1006);
  handshake(2);
  sockets[2]?.push({ op: 0, s: 2, t: "MESSAGE_CREATE", d: message("33") });
  await f.inbound.drain();
  expect(f.ids()).toEqual(["30", "31", "32", "33"]);
  sockets[2]?.drop(4004);
  await expect(done).rejects.toThrow("watch failed");
  expect(phases).toEqual(["connected", "disconnected; reconnecting", "connected", "disconnected; reconnecting", "connected", "gateway failed"]);
  expect(phases.join(" ")).not.toContain("tok");
});
