import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/server/http.ts";
import type { ServerMessage, RoomView } from "../src/protocol.ts";

let app: App;
let baseUrl: string;
let wsUrl: string;
let dataDir: string;

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "typerace-test-"));
  app = createApp({ dataDir, countdownMs: 40, maxRaceMs: 3000 });
  const port = await app.start(0);
  baseUrl = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/ws`;
});

after(async () => {
  if (app) await app.stop();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

type Client = {
  ws: WebSocket;
  messages: ServerMessage[];
  send: (message: unknown) => void;
  waitFor: <T extends ServerMessage>(predicate: (m: ServerMessage) => boolean, label: string) => Promise<T>;
  lastRoom: () => RoomView | undefined;
  close: () => Promise<void>;
};

async function connect(): Promise<Client> {
  const ws = new WebSocket(wsUrl);
  const messages: ServerMessage[] = [];
  ws.addEventListener("message", (event) => {
    messages.push(JSON.parse(String(event.data)) as ServerMessage);
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("connect failed")));
    setTimeout(() => reject(new Error("connect timeout")), 2000);
  });
  const waitFor = <T extends ServerMessage>(predicate: (m: ServerMessage) => boolean, label: string): Promise<T> =>
    new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        const found = messages.find(predicate);
        if (found) {
          clearInterval(timer);
          resolve(found as T);
        } else if (Date.now() - started > 3000) {
          clearInterval(timer);
          reject(new Error(`timeout waiting for ${label}`));
        }
      }, 5);
    });
  const lastRoom = (): RoomView | undefined => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i]!;
      if (m.type === "room") return m.room;
      if (m.type === "joined") return m.room;
    }
    return undefined;
  };
  return {
    ws,
    messages,
    send: (message) => ws.send(JSON.stringify(message)),
    waitFor,
    lastRoom,
    close: () =>
      new Promise<void>((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) return resolve();
        ws.addEventListener("close", () => resolve());
        ws.close();
      }),
  };
}

test("GET /api/health は ok を返す", async () => {
  const res = await fetch(`${baseUrl}/api/health`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { status: string };
  assert.equal(body.status, "ok");
});

test("GET /api/texts はお題一覧を返す", async () => {
  const res = await fetch(`${baseUrl}/api/texts`);
  const body = await res.json();
  assert.ok(Array.isArray(body));
  assert.ok(body.length >= 3);
  assert.ok(body.every((t: { id?: string }) => typeof t.id === "string"));
});

test("GET /api/leaderboard は配列を返す", async () => {
  const res = await fetch(`${baseUrl}/api/leaderboard`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(await res.json()));
});

test("静的ファイル index.html を配信しパストラバーサルを防ぐ", async () => {
  const res = await fetch(baseUrl);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /html/);
  assert.match(await res.text(), /<html/i);
  const traversal = await fetch(`${baseUrl}/..%2f..%2f..%2fetc%2fpasswd`);
  assert.notEqual(traversal.status, 200);
});

test("未知のAPIルートは404", async () => {
  assert.equal((await fetch(`${baseUrl}/api/nope`)).status, 404);
});

test("WebSocket: ルーム作成→参加→対戦→結果確定の一連の流れ", async () => {
  const host = await connect();
  host.send({ type: "join", name: "Alice" });
  const joined = await host.waitFor<Extract<ServerMessage, { type: "joined" }>>(
    (m) => m.type === "joined",
    "joined",
  );
  const code = joined.you.code;
  assert.equal(joined.you.isHost, true);
  assert.equal(code.length, 4);
  const target = joined.room.target;

  const guest = await connect();
  guest.send({ type: "join", name: "Bob", code });
  await guest.waitFor((m) => m.type === "joined", "guest joined");

  host.waitFor((m) => m.type === "room" && m.room.players.length === 2, "2 players");
  guest.send({ type: "ready", ready: true });

  host.send({ type: "start" });
  await host.waitFor((m) => m.type === "room" && m.room.status === "racing", "racing");
  await guest.waitFor((m) => m.type === "room" && m.room.status === "racing", "racing guest");

  host.send({ type: "progress", typed: target });
  guest.send({ type: "progress", typed: target });

  const finished = await host.waitFor<Extract<ServerMessage, { type: "room" }>>(
    (m) => m.type === "room" && m.room.status === "finished",
    "finished",
  );
  assert.equal(finished.room.players.length, 2);
  const ranks = finished.room.players.map((p) => p.rank).sort((a, b) => (a ?? 99) - (b ?? 99));
  assert.deepEqual(ranks, [1, 2]);
  assert.ok(finished.room.players.every((p) => p.wpm >= 0));

  await host.close();
  await guest.close();
});

test("WebSocket: 存在しないコードへの参加はエラー", async () => {
  const c = await connect();
  c.send({ type: "join", name: "X", code: "ZZZZ" });
  const err = await c.waitFor<Extract<ServerMessage, { type: "error" }>>((m) => m.type === "error", "error");
  assert.match(err.message, /見つかりません/);
  await c.close();
});

test("WebSocket: 空名はエラー", async () => {
  const c = await connect();
  c.send({ type: "join", name: "   " });
  await c.waitFor((m) => m.type === "error", "error");
  await c.close();
});

test("WebSocket: 不正JSONはエラーになる", async () => {
  const c = await connect();
  c.ws.send("{not json");
  await c.waitFor((m) => m.type === "error", "error");
  await c.close();
});

test("WebSocket: ホスト以外は開始できない", async () => {
  const host = await connect();
  host.send({ type: "join", name: "H" });
  const j = await host.waitFor<Extract<ServerMessage, { type: "joined" }>>((m) => m.type === "joined", "joined");
  const guest = await connect();
  guest.send({ type: "join", name: "G", code: j.you.code });
  await guest.waitFor((m) => m.type === "joined", "guest");
  guest.send({ type: "start" });
  const err = await guest.waitFor<Extract<ServerMessage, { type: "error" }>>((m) => m.type === "error", "error");
  assert.match(err.message, /ホスト/);
  await host.close();
  await guest.close();
});

test("対戦結果がリーダーボードAPIに反映される", async () => {
  const host = await connect();
  host.send({ type: "join", name: "Solo" });
  const j = await host.waitFor<Extract<ServerMessage, { type: "joined" }>>((m) => m.type === "joined", "joined");
  host.send({ type: "start" });
  await host.waitFor((m) => m.type === "room" && m.room.status === "racing", "racing");
  host.send({ type: "progress", typed: j.room.target });
  await host.waitFor((m) => m.type === "room" && m.room.status === "finished", "finished");
  await host.close();

  let board: Array<{ name: string }> = [];
  for (let i = 0; i < 20; i += 1) {
    board = (await (await fetch(`${baseUrl}/api/leaderboard`)).json()) as Array<{ name: string }>;
    if (board.some((e) => e.name === "Solo")) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(board.some((e) => e.name === "Solo"));
});
