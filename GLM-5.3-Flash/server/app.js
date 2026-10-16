import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const PUBLIC_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'public');
const MAX_BODY = 1_000_000; // 1MB

const trimTitle = (v) => (typeof v === 'string' ? v.trim().slice(0, 200) : '');
const boolOr = (v, fallback) => (typeof v === 'boolean' ? v : fallback);

export function createApp({ dataDir = join(process.cwd(), 'data') } = {}) {
  const store = new Store(dataDir);
  const sseClients = new Set();
  let server = null;
  let port = null;

  const broadcast = (event, payload) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of sseClients) {
      try { res.write(frame); } catch { sseClients.delete(res); }
    }
  };

  const sendJson = (res, status, body) => {
    const data = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(data);
  };

  const sendError = (res, status, message) => sendJson(res, status, { error: message });

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          reject(Object.assign(new Error('payload too large'), { status: 413 }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });

  const parseJsonBody = async (req) => {
    const raw = await readBody(req);
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null ? parsed : {};
    } catch {
      throw Object.assign(new Error('invalid JSON'), { status: 400 });
    }
  };

  // ---- API handlers -------------------------------------------------------

  const handleBoard = (_req, res) => sendJson(res, 200, store.snapshot());

  const handleStats = (_req, res) => {
    const tasks = store.tasks;
    const done = tasks.filter((t) => t.done).length;
    sendJson(res, 200, {
      columns: store.columns.length,
      total: tasks.length,
      done,
      open: tasks.length - done,
      completionRate: tasks.length === 0 ? 0 : Math.round((done / tasks.length) * 1000) / 10,
    });
  };

  const createColumn = async (req, res) => {
    const body = await parseJsonBody(req);
    const title = trimTitle(body.title);
    if (!title) return sendError(res, 400, 'title is required');
    const id = await store.mutate((_state, createId) => {
      const column = { id: createId(), title, createdAt: new Date().toISOString() };
      _state.columns.push(column);
      broadcast('column-created', column);
      return column;
    });
    sendJson(res, 201, id);
  };

  const updateColumn = async (req, res, params) => {
    const body = await parseJsonBody(req);
    const title = trimTitle(body.title);
    if (!title) return sendError(res, 400, 'title is required');
    const existing = store.columns.find((c) => c.id === params.id);
    if (!existing) return sendError(res, 404, 'column not found');
    const updated = await store.mutate(() => {
      existing.title = title;
      broadcast('column-updated', existing);
      return existing;
    });
    sendJson(res, 200, updated);
  };

  const deleteColumn = (_req, res, params) => {
    let removed = null;
    store.mutate((state) => {
      const idx = state.columns.findIndex((c) => c.id === params.id);
      if (idx === -1) return;
      removed = state.columns[idx];
      state.columns.splice(idx, 1);
      state.tasks = state.tasks.filter((t) => t.columnId !== params.id);
      if (removed) {
        broadcast('column-deleted', { ...removed });
        broadcast('board-updated', store.snapshot());
      }
    });
    if (!removed) return sendError(res, 404, 'column not found');
    res.writeHead(204).end();
  };

  const createTask = async (req, res) => {
    const body = await parseJsonBody(req);
    const title = trimTitle(body.title);
    if (!title) return sendError(res, 400, 'title is required');
    if (!store.columns.some((c) => c.id === body.columnId)) {
      return sendError(res, 404, 'column not found');
    }
    const task = await store.mutate((state, createId) => {
      const columnTasks = state.tasks.filter((t) => t.columnId === body.columnId);
      const newTask = {
        id: createId(),
        columnId: body.columnId,
        title,
        assignee: trimTitle(body.assignee) || null,
        priority: ['low', 'medium', 'high'].includes(body.priority) ? body.priority : 'medium',
        done: boolOr(body.done, false),
        createdAt: new Date().toISOString(),
        order: columnTasks.length,
      };
      state.tasks.push(newTask);
      broadcast('task-created', newTask);
      return newTask;
    });
    sendJson(res, 201, task);
  };

  const updateTask = async (req, res, params) => {
    const body = await parseJsonBody(req);
    if (body.done !== undefined && typeof body.done !== 'boolean') {
      return sendError(res, 400, 'done must be boolean');
    }
    if (body.columnId !== undefined && !store.columns.some((c) => c.id === body.columnId)) {
      return sendError(res, 404, 'column not found');
    }
    const existing = store.tasks.find((t) => t.id === params.id);
    if (!existing) return sendError(res, 404, 'task not found');

    const updated = await store.mutate((state) => {
      const task = state.tasks.find((t) => t.id === params.id);
      if (body.title !== undefined) {
        const title = trimTitle(body.title);
        if (!title) {
          throw Object.assign(new Error('title is required'), { status: 400 });
        }
        task.title = title;
      }
      if (body.assignee !== undefined) task.assignee = trimTitle(body.assignee) || null;
      if (body.priority !== undefined && ['low', 'medium', 'high'].includes(body.priority)) {
        task.priority = body.priority;
      }
      if (body.done !== undefined) task.done = body.done;
      if (body.columnId !== undefined && body.columnId !== task.columnId) {
        const targetColumnTasks = state.tasks.filter(
          (t) => t.columnId === body.columnId && t.id !== task.id,
        );
        task.columnId = body.columnId;
        task.order = typeof body.order === 'number' && Number.isFinite(body.order)
          ? Math.max(0, Math.min(Math.floor(body.order), targetColumnTasks.length))
          : targetColumnTasks.length;
        // 同一カラム内の順序を詰める
        state.tasks
          .filter((t) => t.columnId === task.columnId)
          .sort((a, b) => a.order - b.order)
          .forEach((t, i) => { t.order = i; });
      } else if (body.order !== undefined) {
        task.order = Math.max(0, Math.floor(Number(body.order) || 0));
      }
      task.updatedAt = new Date().toISOString();
      broadcast('task-updated', task);
      return task;
    });
    sendJson(res, 200, updated);
  };

  const deleteTask = (_req, res, params) => {
    const idx = store.tasks.findIndex((t) => t.id === params.id);
    if (idx === -1) return sendError(res, 404, 'task not found');
    store.mutate((state) => {
      const [removed] = state.tasks.splice(idx, 1);
      state.tasks
        .filter((t) => t.columnId === removed.columnId)
        .sort((a, b) => a.order - b.order)
        .forEach((t, i) => { t.order = i; });
      broadcast('task-deleted', removed);
    });
    res.writeHead(204).end();
  };

  const handleEvents = (req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    sseClients.add(res);
    const keepAlive = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* closed */ }
    }, 15000);
    req.on('close', () => {
      clearInterval(keepAlive);
      sseClients.delete(res);
    });
  };

  // ---- routing ------------------------------------------------------------

  const apiRoutes = [
    { method: 'GET', pattern: /^\/api\/health$/, handler: (_req, res) => sendJson(res, 200, { status: 'ok' }) },
    { method: 'GET', pattern: /^\/api\/board$/, handler: handleBoard },
    { method: 'GET', pattern: /^\/api\/stats$/, handler: handleStats },
    { method: 'POST', pattern: /^\/api\/columns$/, handler: createColumn },
    { method: 'PATCH', pattern: /^\/api\/columns\/(?<id>[\w-]+)$/, handler: updateColumn },
    { method: 'DELETE', pattern: /^\/api\/columns\/(?<id>[\w-]+)$/, handler: deleteColumn },
    { method: 'POST', pattern: /^\/api\/tasks$/, handler: createTask },
    { method: 'PATCH', pattern: /^\/api\/tasks\/(?<id>[\w-]+)$/, handler: updateTask },
    { method: 'DELETE', pattern: /^\/api\/tasks\/(?<id>[\w-]+)$/, handler: deleteTask },
    { method: 'GET', pattern: /^\/api\/events$/, handler: handleEvents },
  ];

  const matchRoute = (req) => {
    const found = apiRoutes.filter((r) => r.method === req.method).find((r) => r.pattern.test(req.url));
    if (found) {
      const m = req.url.match(found.pattern);
      return { ...found, params: m.groups ?? {} };
    }
    return null;
  };

  const serveStatic = async (req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
      return sendError(res, 400, 'bad request');
    }
    if (pathname === '/') pathname = '/index.html';

    const safePath = normalize(join(PUBLIC_DIR, pathname));
    if (!safePath.startsWith(PUBLIC_DIR)) {
      return sendError(res, 403, 'forbidden');
    }

    try {
      const info = await stat(safePath);
      const file = info.isDirectory() ? join(safePath, 'index.html') : safePath;
      const content = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(content);
    } catch {
      sendError(res, 404, 'not found');
    }
  };

  const requestHandler = async (req, res) => {
    try {
      if (req.url.startsWith('/api/')) {
        const route = matchRoute(req);
        if (!route) {
          const methodMatches = apiRoutes.some((r) => r.pattern.test(req.url));
          return sendError(res, methodMatches ? 405 : 404, 'not found');
        }
        await route.handler(req, res, route.params);
        return;
      }
      await serveStatic(req, res);
    } catch (err) {
      console.error(`[server] ${req.method} ${req.url} failed:`, err.message);
      sendError(res, err.status ?? 500, err.message ?? 'internal server error');
    }
  };

  return {
    get port() { return port; },
    async load() { return store.load(); },
    async start(preferredPort = 3000) {
      await store.load();
      server = createServer(requestHandler);
      server.on('clientError', (_err, socket) => {
        if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(preferredPort, '0.0.0.0', () => resolve());
      });
      port = server.address().port;
      return port;
    },
    async stop() {
      if (!server) return;
      await new Promise((resolve) => server.close(resolve));
      for (const client of sseClients) client.end?.();
      sseClients.clear();
      await store.close();
      server = null;
      port = null;
    },
  };
}

// ---- CLI entry point ------------------------------------------------------

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const app = createApp({ dataDir: join(process.cwd(), 'data') });
  const PORT = Number(process.env.PORT) || 3000;
  app
    .start(PORT)
    .then((p) => console.log(`GLM Board listening on http://localhost:${p}`))
    .catch((err) => {
      console.error('failed to start server:', err);
      process.exit(1);
    });

  const shutdown = async () => {
    console.log('\nshutting down...');
    await app.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
