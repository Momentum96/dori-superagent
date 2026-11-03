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
  const transport: DiscordInboundTransport = {
    getChannel: async (id) => ({ type: ["2", "4", "5"].includes(id) ? 11 : 0, parent_id: MAIN }),
    getMessages: async (id) => {
      if (unreadable.has(id)) throw new MessengerError(`discord GET /channels/${id}/messages: 404 {"message": "Unknown Channel"}`, 404);
      return history[id] ?? [];
    },
    activeThreads: async () => [{ id: "2", type: 11, parent_id: MAIN }, { id: "3", type: 11, parent_id: "other" }],
  };
  const inbound = new DiscordInbound(MAIN, OWNER, state, transport, async (line) => { lines.push(line); }, async (s) => { saved.push(structuredClone(s)); });
  const ids = () => lines.map((l) => (JSON.parse(l) as { messageId: string }).messageId);
  return { inbound, lines, saved, history, unreadable, ids, state };
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
  f.history[MAIN] = [message("14"), message("13")];
  await Promise.all([f.inbound.recover(), f.inbound.accept(message("14")), f.inbound.accept(message("13"))]);
  expect(f.ids()).toEqual(["13", "14"]);
  expect(JSON.parse(f.lines[0] ?? "{}")).toMatchObject({ event: "DORI_INBOUND", channelId: MAIN, authorId: OWNER, content: "m13" });
  const restarted = fixture(f.saved.at(-1));
  restarted.history[MAIN] = [message("15"), message("14"), message("13")];
  await restarted.inbound.recover();
  expect(restarted.ids()).toEqual(["15"]);
});

test("the gateway recovers on every session, delivers live messages, reconnects after a drop and stops on a fatal close", async () => {
  const f = fixture();
  f.history[MAIN] = [message("30")];
  const sockets: { sent: string[]; push: (m: object) => void; drop: (code: number) => void }[] = [];
  const open = (): InboundSocket => {
    let onMessage: (d: string) => void = () => {};
    let onClose: (c: number) => void = () => {};
    const s = { sent: [] as string[], push: (m: object) => onMessage(JSON.stringify(m)), drop: (c: number) => onClose(c) };
    sockets.push(s);
    return { send: (d) => s.sent.push(d), close: () => {}, onMessage: (cb) => { onMessage = cb; }, onClose: (cb) => { onClose = cb; } };
  };
  const timers = { setInterval: () => 0, clearInterval: () => {}, setTimeout: (cb: () => void) => cb() };
  const listener = new DiscordGatewayListener(open, "tok", timers);
  const phases: string[] = [];
  const done = watchDiscordInbound(listener, f.inbound, new AbortController().signal, (p) => phases.push(p));
  sockets[0]?.push({ op: 10, d: { heartbeat_interval: 1000 } });
  expect(JSON.parse(sockets[0]?.sent[0] ?? "{}")).toMatchObject({ op: 2, d: { token: "tok" } });
  sockets[0]?.push({ op: 0, s: 1, t: "READY", d: {} });
  sockets[0]?.push({ op: 0, s: 2, t: "MESSAGE_CREATE", d: message("31") });
  await f.inbound.drain();
  expect(f.ids()).toEqual(["30", "31"]);
  sockets[0]?.drop(1006);
  f.history[MAIN] = [message("32"), message("31"), message("30")];
  sockets[1]?.push({ op: 0, s: 1, t: "READY", d: {} });
  await f.inbound.drain();
  expect(f.ids()).toEqual(["30", "31", "32"]);
  sockets[1]?.drop(4004);
  await expect(done).rejects.toThrow("watch failed");
  expect(phases).toEqual(["connected", "disconnected; reconnecting", "connected", "gateway failed"]);
  expect(phases.join(" ")).not.toContain("tok");
});
