import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createLeaderboard } from "./store.ts";
import { createHub, type Hub } from "./hub.ts";
import { TEXTS } from "../game/texts.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const DEFAULT_PUBLIC_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "public");

export type AppOptions = {
  dataDir?: string;
  publicDir?: string;
  countdownMs?: number;
  maxRaceMs?: number;
};

export type App = {
  readonly port: number;
  start: (preferredPort?: number) => Promise<number>;
  stop: () => Promise<void>;
  hub: Hub;
};

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(data) });
  res.end(data);
};

export function createApp(options: AppOptions = {}): App {
  const publicDir = options.publicDir ?? DEFAULT_PUBLIC_DIR;
  const dataDir = options.dataDir ?? join(process.cwd(), "data");
  const leaderboard = createLeaderboard(dataDir);
  const hub = createHub({
    leaderboard,
    countdownMs: options.countdownMs,
    maxRaceMs: options.maxRaceMs,
  });

  let server: Server | null = null;
  let port = 0;

  const serveStatic = async (req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> => {
    const relative = pathname === "/" ? "/index.html" : pathname;
    const safePath = normalize(join(publicDir, relative));
    if (!safePath.startsWith(normalize(publicDir))) {
      sendJson(res, 403, { error: "forbidden" });
      return;
    }
    try {
      const info = await stat(safePath);
      const file = info.isDirectory() ? join(safePath, "index.html") : safePath;
      const content = await readFile(file);
      res.writeHead(200, {
        "content-type": MIME[extname(file)] ?? "application/octet-stream",
        "content-length": content.length,
        "cache-control": "no-cache",
      });
      res.end(content);
    } catch {
      sendJson(res, 404, { error: "not found" });
    }
  };

  const handleApi = async (req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> => {
    const method = req.method ?? "GET";
    if (pathname === "/api/health" && method === "GET") {
      sendJson(res, 200, { status: "ok", rooms: hub.roomCount(), uptime: Math.round(process.uptime()) });
      return true;
    }
    if (pathname === "/api/texts" && method === "GET") {
      sendJson(res, 200, TEXTS.map((t) => ({ id: t.id, title: t.title, difficulty: t.difficulty, length: t.content.length })));
      return true;
    }
    if (pathname === "/api/leaderboard" && method === "GET") {
      sendJson(res, 200, leaderboard.top(10));
      return true;
    }
    const roomMatch = /^\/api\/rooms\/([A-Za-z0-9]+)$/.exec(pathname);
    if (roomMatch && method === "GET") {
      const view = hub.getRoomView(roomMatch[1]!);
      if (!view) {
        sendJson(res, 404, { error: "room not found" });
        return true;
      }
      sendJson(res, 200, view);
      return true;
    }
    if (pathname.startsWith("/api/")) {
      sendJson(res, 404, { error: "not found" });
      return true;
    }
    return false;
  };

  const requestHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let pathname = "/";
    try {
      pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
    } catch {
      sendJson(res, 400, { error: "bad request" });
      return;
    }
    try {
      const handled = await handleApi(req, res, pathname);
      if (handled) return;
      await serveStatic(req, res, pathname);
    } catch (err) {
      console.error("[http] request failed:", (err as Error).message);
      if (!res.headersSent) sendJson(res, 500, { error: "internal server error" });
      else res.end();
    }
  };

  return {
    get port() {
      return port;
    },
    hub,
    async start(preferredPort = 3000) {
      await leaderboard.load();
      server = createServer((req, res) => {
        void requestHandler(req, res);
      });
      server.on("clientError", (_err, socket) => {
        if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      });
      hub.attach(server);
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(preferredPort, "127.0.0.1", () => resolve());
      });
      port = (server.address() as { port: number }).port;
      return port;
    },
    async stop() {
      hub.close();
      await leaderboard.flush();
      if (!server) return;
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
      port = 0;
    },
  };
}
