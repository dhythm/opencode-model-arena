import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { attachWebSocket, computeAcceptKey } from "../src/server/websocket.ts";

let server: Server;
let port = 0;

before(async () => {
  server = createServer((_req, res) => {
    res.writeHead(426).end();
  });
  attachWebSocket(server, (conn) => {
    conn.onMessage((text) => {
      if (text === "__close__") {
        conn.close(1000, "bye");
        return;
      }
      conn.send(`echo:${text}`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const url = (): string => `ws://127.0.0.1:${port}/ws`;

type Harness = {
  ws: WebSocket;
  messages: string[];
  closed: Promise<{ code: number; reason: string }>;
  waitFor: (predicate: (messages: string[]) => boolean) => Promise<void>;
};

function open(): Promise<Harness> {
  const ws = new WebSocket(url());
  const messages: string[] = [];
  let closeResolve: (value: { code: number; reason: string }) => void = () => {};
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    closeResolve = resolve;
  });
  ws.addEventListener("message", (event) => {
    messages.push(String(event.data));
  });
  ws.addEventListener("close", (event) => {
    closeResolve({ code: event.code, reason: event.reason });
  });
  const waitFor = (predicate: (m: string[]) => boolean): Promise<void> =>
    new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (predicate(messages)) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() - started > 2000) {
          clearInterval(timer);
          reject(new Error(`timeout waiting; got ${JSON.stringify(messages)}`));
        }
      }, 5);
    });
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve({ ws, messages, closed, waitFor }));
    ws.addEventListener("error", () => reject(new Error("failed to open websocket")));
    setTimeout(() => reject(new Error("open timeout")), 2000);
  });
}

test("computeAcceptKey: RFC6455 の例と一致する", () => {
  assert.equal(
    computeAcceptKey("dGhlIHNhbXBsZSBub25jZQ=="),
    "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
  );
});

test("ハンドシェイク後にテキストを送受信できる", async () => {
  const h = await open();
  h.ws.send("hello");
  await h.waitFor((m) => m.includes("echo:hello"));
  assert.deepEqual(h.messages, ["echo:hello"]);
  h.ws.close();
  await h.closed;
});

test("連続メッセージを順序どおりに処理する", async () => {
  const h = await open();
  h.ws.send("a");
  h.ws.send("b");
  h.ws.send("c");
  await h.waitFor((m) => m.length === 3);
  assert.deepEqual(h.messages, ["echo:a", "echo:b", "echo:c"]);
  h.ws.close();
  await h.closed;
});

test("大きなメッセージ(16bit長を超える)を往復できる", async () => {
  const h = await open();
  const big = "x".repeat(70_000);
  h.ws.send(big);
  await h.waitFor((m) => m.length === 1);
  assert.equal(h.messages[0], `echo:${big}`);
  h.ws.close();
  await h.closed;
});

test("さらに大きなメッセージ(64bit長経路)を往復できる", async () => {
  const h = await open();
  const big = "y".repeat(200_000);
  h.ws.send(big);
  await h.waitFor((m) => m.length === 1);
  assert.equal(h.messages[0]?.length, big.length + 5);
  h.ws.close();
  await h.closed;
});

test("サーバからのcloseでクライアントが閉じる", async () => {
  const h = await open();
  h.ws.send("__close__");
  const info = await h.closed;
  assert.equal(info.code, 1000);
  assert.equal(info.reason, "bye");
});

test("異なるパスへの接続は拒否される", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/nope`);
  const result = await new Promise<string>((resolve) => {
    ws.addEventListener("open", () => resolve("open"));
    ws.addEventListener("error", () => resolve("error"));
    setTimeout(() => resolve("timeout"), 1500);
  });
  assert.notEqual(result, "open");
});

test("同時に複数クライアントを扱える", async () => {
  const [a, b] = await Promise.all([open(), open()]);
  a.ws.send("1");
  b.ws.send("2");
  await a.waitFor((m) => m.includes("echo:1"));
  await b.waitFor((m) => m.includes("echo:2"));
  assert.equal(a.messages[0], "echo:1");
  assert.equal(b.messages[0], "echo:2");
  a.ws.close();
  b.ws.close();
  await Promise.all([a.closed, b.closed]);
});
