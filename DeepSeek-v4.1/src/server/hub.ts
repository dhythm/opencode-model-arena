import type { Server } from "node:http";
import type { ServerMessage, ClientMessage } from "../protocol.ts";
import { parseClientMessage } from "../protocol.ts";
import { attachWebSocket, type WSConnection } from "./websocket.ts";
import type { Leaderboard } from "./store.ts";
import * as room from "../game/room.ts";
import { pickRandomTextId } from "../game/texts.ts";

const MAX_PLAYERS = 16;
const MAX_ROOMS = 500;
const ROOM_TTL_MS = 30 * 60_000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export type HubOptions = {
  leaderboard: Leaderboard;
  countdownMs?: number;
  maxRaceMs?: number;
  now?: () => number;
  rng?: () => number;
};

export type Hub = {
  attach: (server: Server) => void;
  roomCount: () => number;
  getRoomView: (code: string) => ReturnType<typeof room.serialize> | null;
  close: () => void;
};

type ConnState = {
  conn: WSConnection;
  roomCode: string | null;
  playerId: string | null;
};

export function createHub(options: HubOptions): Hub {
  const leaderboard = options.leaderboard;
  const countdownMs = options.countdownMs ?? 3000;
  const maxRaceMs = options.maxRaceMs ?? 5 * 60_000;
  const now = options.now ?? (() => Date.now());
  const rng = options.rng ?? (() => Math.random());

  const rooms = new Map<string, room.Room>();
  const connections = new Map<string, ConnState>();
  const raceTimers = new Map<string, NodeJS.Timeout>();
  const watchdogs = new Set<NodeJS.Timeout>();

  const normalizeName = (value: unknown): string =>
    typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, 20) : "";

  const send = (conn: WSConnection, message: ServerMessage): void => {
    conn.send(JSON.stringify(message));
  };

  const broadcast = (code: string): void => {
    const target = rooms.get(code);
    if (!target) return;
    const view = room.serialize(target, now());
    for (const state of connections.values()) {
      if (state.roomCode === code) send(state.conn, { type: "room", room: view });
    }
  };

  const clearRaceTimer = (code: string): void => {
    const timer = raceTimers.get(code);
    if (timer) {
      clearTimeout(timer);
      raceTimers.delete(code);
    }
  };

  const finalizeRoom = (code: string): void => {
    const target = rooms.get(code);
    if (!target || target.status !== "racing") return;
    clearRaceTimer(code);
    const entries = room.finalize(target, now());
    leaderboard.record(entries);
    broadcast(code);
  };

  const scheduleRace = (code: string): void => {
    clearRaceTimer(code);
    const timer = setTimeout(() => finalizeRoom(code), maxRaceMs);
    timer.unref?.();
    raceTimers.set(code, timer);
  };

  const destroyRoom = (code: string): void => {
    clearRaceTimer(code);
    rooms.delete(code);
  };

  const generateCode = (): string => {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      let code = "";
      for (let i = 0; i < 4; i += 1) {
        code += CODE_ALPHABET[Math.floor(rng() * CODE_ALPHABET.length)] ?? "A";
      }
      if (!rooms.has(code)) return code;
    }
    return `R${Math.floor(rng() * 1000)}`;
  };

  const findRoomByCode = (raw: unknown): room.Room | null => {
    if (typeof raw !== "string") return null;
    return rooms.get(raw.trim().toUpperCase()) ?? null;
  };

  const handleJoin = (state: ConnState, message: Extract<ClientMessage, { type: "join" }>): void => {
    if (state.roomCode) {
      send(state.conn, { type: "error", message: "already joined" });
      return;
    }
    const name = normalizeName(message.name);
    if (!name) {
      send(state.conn, { type: "error", message: "名前を入力してください" });
      return;
    }
    const wantsCode = typeof message.code === "string" && message.code.trim() !== "";
    let target: room.Room;
    if (wantsCode) {
      const found = findRoomByCode(message.code);
      if (!found) {
        send(state.conn, { type: "error", message: "指定したルームが見つかりません" });
        return;
      }
      if (found.status !== "lobby") {
        send(state.conn, { type: "error", message: "このルームは進行中です" });
        return;
      }
      if (found.players.length >= MAX_PLAYERS) {
        send(state.conn, { type: "error", message: "ルームが満員です" });
        return;
      }
      target = found;
    } else {
      if (rooms.size >= MAX_ROOMS) {
        send(state.conn, { type: "error", message: "サーバーが混雑しています" });
        return;
      }
      const code = generateCode();
      target = room.createRoom({ code, hostId: state.conn.id, textId: pickRandomTextId(), now: now() });
      rooms.set(code, target);
    }
    room.addPlayer(target, state.conn.id, name);
    state.roomCode = target.code;
    state.playerId = state.conn.id;
    const view = room.serialize(target, now());
    send(state.conn, { type: "joined", you: { id: state.conn.id, isHost: target.hostId === state.conn.id, code: target.code }, room: view });
    broadcast(target.code);
  };

  const handleStart = (state: ConnState): void => {
    const target = state.roomCode ? rooms.get(state.roomCode) : null;
    if (!target) return;
    if (!room.isHost(target, state.conn.id)) {
      send(state.conn, { type: "error", message: "開始できるのはホストだけです" });
      return;
    }
    if (!room.startCountdown(target, now(), countdownMs)) {
      send(state.conn, { type: "error", message: "いまは開始できません" });
      return;
    }
    broadcast(target.code);
    const timer = setTimeout(() => {
      const current = rooms.get(target.code);
      if (!current || current.status !== "countdown") return;
      room.beginRace(current, now());
      broadcast(current.code);
      scheduleRace(current.code);
    }, countdownMs);
    timer.unref?.();
    watchdogs.add(timer);
  };

  const handleProgress = (state: ConnState, message: Extract<ClientMessage, { type: "progress" }>): void => {
    const target = state.roomCode ? rooms.get(state.roomCode) : null;
    if (!target || typeof message.typed !== "string") return;
    const result = room.submitProgress(target, state.conn.id, message.typed, now());
    broadcast(target.code);
    if (result.finished) {
      const anyFinished = target.players.some((p) => p.finished);
      if (anyFinished && room.allConnectedFinished(target)) finalizeRoom(target.code);
    }
  };

  const handleMessage = (state: ConnState, message: ClientMessage): void => {
    switch (message.type) {
      case "join":
        handleJoin(state, message);
        break;
      case "ready": {
        const target = state.roomCode ? rooms.get(state.roomCode) : null;
        if (!target) return;
        room.setReady(target, state.conn.id, message.ready === true);
        broadcast(target.code);
        break;
      }
      case "start":
        handleStart(state);
        break;
      case "progress":
        handleProgress(state, message);
        break;
      case "setText": {
        const target = state.roomCode ? rooms.get(state.roomCode) : null;
        if (!target || !room.isHost(target, state.conn.id)) return;
        if (room.setTextId(target, String(message.textId))) broadcast(target.code);
        break;
      }
      case "rematch": {
        const target = state.roomCode ? rooms.get(state.roomCode) : null;
        if (!target || !room.isHost(target, state.conn.id)) return;
        if (room.resetForRematch(target, now())) broadcast(target.code);
        break;
      }
      default:
        break;
    }
  };

  const handleDisconnect = (state: ConnState): void => {
    connections.delete(state.conn.id);
    const code = state.roomCode;
    if (!code) return;
    const target = rooms.get(code);
    if (!target) return;
    room.removePlayer(target, state.conn.id);
    if (target.players.length === 0) {
      destroyRoom(code);
      return;
    }
    if (target.status === "racing" && room.allConnectedFinished(target)) {
      finalizeRoom(code);
      return;
    }
    broadcast(code);
  };

  return {
    attach(server) {
      attachWebSocket(server, (conn) => {
        const state: ConnState = { conn, roomCode: null, playerId: null };
        connections.set(conn.id, state);
        conn.onMessage((text) => {
          const parsed = parseClientMessage(text);
          if (!parsed) {
            send(conn, { type: "error", message: "不正なメッセージです" });
            return;
          }
          try {
            handleMessage(state, parsed);
          } catch (err) {
            console.error("[hub] handler error:", (err as Error).message);
            send(conn, { type: "error", message: "サーバーエラー" });
          }
        });
        conn.onClose(() => handleDisconnect(state));
      });

      const sweep = setInterval(() => {
        const cutoff = now() - ROOM_TTL_MS;
        for (const [code, target] of rooms) {
          if (target.players.length === 0 && target.createdAt < cutoff) destroyRoom(code);
        }
      }, 60_000);
      sweep.unref?.();
      watchdogs.add(sweep);
    },
    roomCount() {
      return rooms.size;
    },
    getRoomView(code) {
      const target = rooms.get(code.trim().toUpperCase());
      return target ? room.serialize(target, now()) : null;
    },
    close() {
      for (const timer of watchdogs) clearTimeout(timer as NodeJS.Timeout);
      watchdogs.clear();
      for (const timer of raceTimers.values()) clearTimeout(timer);
      raceTimers.clear();
      rooms.clear();
      connections.clear();
    },
  };
}
