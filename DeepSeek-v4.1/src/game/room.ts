import type { LeaderboardEntry, PlayerView, RoomStatus, RoomView } from "../protocol.ts";
import { computeAccuracy, computeWpm, elapsedMs, evaluateProgress } from "./scoring.ts";
import { resolveText } from "./texts.ts";

export type Player = {
  id: string;
  name: string;
  ready: boolean;
  connected: boolean;
  typed: string;
  correctChars: number;
  errors: number;
  progress: number;
  finished: boolean;
  finishMs: number | null;
  wpm: number;
  accuracy: number;
  rank: number | null;
};

export type Room = {
  code: string;
  hostId: string;
  status: RoomStatus;
  textId: string;
  startedAt: number | null;
  countdownEndsAt: number | null;
  durationMs: number | null;
  players: Player[];
  createdAt: number;
};

export function createRoom(params: { code: string; hostId: string; textId: string; now: number }): Room {
  return {
    code: params.code,
    hostId: params.hostId,
    status: "lobby",
    textId: params.textId,
    startedAt: null,
    countdownEndsAt: null,
    durationMs: null,
    players: [],
    createdAt: params.now,
  };
}

const makePlayer = (id: string, name: string): Player => ({
  id,
  name,
  ready: false,
  connected: true,
  typed: "",
  correctChars: 0,
  errors: 0,
  progress: 0,
  finished: false,
  finishMs: null,
  wpm: 0,
  accuracy: 100,
  rank: null,
});

export function findPlayer(room: Room, id: string): Player | undefined {
  return room.players.find((p) => p.id === id);
}

export function addPlayer(room: Room, id: string, name: string): Player {
  const player = makePlayer(id, name);
  room.players.push(player);
  return player;
}

export function removePlayer(room: Room, id: string): void {
  room.players = room.players.filter((p) => p.id !== id);
  if (room.hostId === id && room.players.length > 0) {
    const next = room.players.find((p) => p.connected) ?? room.players[0]!;
    room.hostId = next.id;
  }
}

export function isHost(room: Room, id: string): boolean {
  return room.hostId === id;
}

export function setReady(room: Room, id: string, ready: boolean): void {
  const player = findPlayer(room, id);
  if (player) player.ready = ready;
}

export function setTextId(room: Room, textId: string): boolean {
  if (room.status !== "lobby") return false;
  room.textId = resolveText(textId).id;
  return true;
}

export function startCountdown(room: Room, now: number, countdownMs: number): boolean {
  if (room.status !== "lobby" || room.players.length === 0 || room.players.length > 16) return false;
  room.status = "countdown";
  room.countdownEndsAt = now + countdownMs;
  room.startedAt = null;
  room.durationMs = null;
  return true;
}

export function beginRace(room: Room, now: number): void {
  room.status = "racing";
  room.startedAt = now;
  room.durationMs = null;
  for (const player of room.players) {
    player.typed = "";
    player.correctChars = 0;
    player.errors = 0;
    player.progress = 0;
    player.finished = false;
    player.finishMs = null;
    player.wpm = 0;
    player.accuracy = 100;
    player.rank = null;
  }
}

export function submitProgress(room: Room, id: string, typed: string, now: number): { finished: boolean } {
  const player = findPlayer(room, id);
  if (!player || room.status !== "racing") return { finished: false };
  if (player.finished) return { finished: true };

  const { content } = resolveText(room.textId);
  const result = evaluateProgress(content, typed.slice(0, content.length + 50));
  player.typed = typed;
  player.correctChars = result.correctChars;
  player.errors = result.errors;
  player.progress = result.progress;
  const ms = elapsedMs(room.startedAt, now);
  player.wpm = computeWpm(result.correctChars, ms);
  player.accuracy = computeAccuracy(result.correctChars, result.typedLength);

  if (result.finished) {
    player.finished = true;
    player.finishMs = ms;
    player.progress = 1;
    return { finished: true };
  }
  return { finished: false };
}

export function allConnectedFinished(room: Room): boolean {
  const connected = room.players.filter((p) => p.connected);
  if (connected.length === 0) return false;
  return connected.every((p) => p.finished);
}

export function finalize(room: Room, now: number): LeaderboardEntry[] {
  room.status = "finished";
  room.durationMs = elapsedMs(room.startedAt, now);

  const finished = room.players
    .filter((p) => p.finished && p.finishMs !== null)
    .sort((a, b) => (a.finishMs as number) - (b.finishMs as number));
  finished.forEach((p, index) => {
    p.rank = index + 1;
    p.progress = 1;
  });
  for (const p of room.players) {
    if (!p.finished) p.rank = null;
  }

  return finished
    .filter((p) => p.correctChars > 0)
    .map((p) => ({
      name: p.name,
      wpm: p.wpm,
      accuracy: p.accuracy,
      textId: room.textId,
      at: now,
    }));
}

export function resetForRematch(room: Room, now: number): boolean {
  if (room.status !== "finished") return false;
  room.status = "lobby";
  room.startedAt = null;
  room.countdownEndsAt = null;
  room.durationMs = null;
  room.createdAt = now;
  for (const player of room.players) {
    player.ready = false;
    player.typed = "";
    player.correctChars = 0;
    player.errors = 0;
    player.progress = 0;
    player.finished = false;
    player.finishMs = null;
    player.wpm = 0;
    player.accuracy = 100;
    player.rank = null;
  }
  return true;
}

export function ranking(room: Room): Player[] {
  return [...room.players].sort((a, b) => {
    if (a.rank !== null && b.rank !== null) return a.rank - b.rank;
    if (a.rank !== null) return -1;
    if (b.rank !== null) return 1;
    return b.progress - a.progress;
  });
}

export function serialize(room: Room, now: number): RoomView {
  const text = resolveText(room.textId);
  const players: PlayerView[] = room.players.map((p) => ({
    id: p.id,
    name: p.name,
    ready: p.ready,
    connected: p.connected,
    isHost: p.id === room.hostId,
    progress: Math.round(p.progress * 1000) / 1000,
    correctChars: p.correctChars,
    errors: p.errors,
    typedLength: p.typed.length,
    finished: p.finished,
    finishMs: p.finishMs,
    wpm: p.wpm,
    accuracy: p.accuracy,
    rank: p.rank,
  }));
  return {
    code: room.code,
    status: room.status,
    textId: room.textId,
    textTitle: text.title,
    target: text.content,
    hostId: room.hostId,
    startedAt: room.startedAt,
    countdownEndsAt: room.countdownEndsAt,
    durationMs: room.durationMs,
    serverNow: now,
    players,
  };
}
