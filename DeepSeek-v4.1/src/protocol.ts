export type RoomStatus = "lobby" | "countdown" | "racing" | "finished";

export type PlayerView = {
  id: string;
  name: string;
  ready: boolean;
  connected: boolean;
  isHost: boolean;
  progress: number;
  correctChars: number;
  errors: number;
  typedLength: number;
  finished: boolean;
  finishMs: number | null;
  wpm: number;
  accuracy: number;
  rank: number | null;
};

export type RoomView = {
  code: string;
  status: RoomStatus;
  textId: string;
  textTitle: string;
  target: string;
  hostId: string;
  startedAt: number | null;
  countdownEndsAt: number | null;
  durationMs: number | null;
  serverNow: number;
  players: PlayerView[];
};

export type ClientMessage =
  | { type: "join"; name: string; code?: string }
  | { type: "ready"; ready: boolean }
  | { type: "start" }
  | { type: "progress"; typed: string }
  | { type: "rematch" }
  | { type: "setText"; textId: string };

export type ServerMessage =
  | { type: "joined"; you: { id: string; isHost: boolean; code: string }; room: RoomView }
  | { type: "room"; room: RoomView }
  | { type: "error"; message: string };

export type LeaderboardEntry = {
  name: string;
  wpm: number;
  accuracy: number;
  textId: string;
  at: number;
};

export function parseClientMessage(raw: string): ClientMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const type = (parsed as { type?: unknown }).type;
  return typeof type === "string" ? (parsed as ClientMessage) : null;
}
