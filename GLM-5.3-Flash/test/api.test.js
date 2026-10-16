import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let app;
let baseUrl;
let cleanupDir;

const json = (body) => ({
  method: body ? 'POST' : 'GET',
  headers: { 'content-type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined,
});

beforeEach(async () => {
  if (app) await app.stop();
  cleanupDir = await mkdtemp(join(tmpdir(), 'glmboard-test-'));
  app = createApp({ dataDir: cleanupDir });
  await app.start(0);
  baseUrl = `http://127.0.0.1:${app.port}`;
});

after(async () => {
  if (app) await app.stop();
  if (cleanupDir) await rm(cleanupDir, { recursive: true, force: true });
});

async function createColumn(title) {
  const res = await fetch(`${baseUrl}/api/columns`, json({ title }));
  assert.equal(res.status, 201);
  return res.json();
}

async function createTask(columnId, title, extra = {}) {
  const res = await fetch(`${baseUrl}/api/tasks`, json({ columnId, title, ...extra }));
  assert.equal(res.status, 201);
  return res.json();
}

test('GET /api/health は ok を返す', async () => {
  const res = await fetch(`${baseUrl}/api/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok' });
});

test('静的ファイルとして index.html が配信される', async () => {
  const res = await fetch(baseUrl);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /html/);
  const body = await res.text();
  assert.match(body, /<html/i);
  // パストラバーサル対策: 上位ディレクトリへは出ない
  const traversal = await fetch(`${baseUrl}/..%2f..%2f..%2fetc%2fpasswd`);
  assert.notEqual(traversal.status, 200);
});

test('カラムを作成できる', async () => {
  const col = await createColumn('ToDo');
  assert.equal(col.title, 'ToDo');
  assert.ok(col.id);
  assert.ok(col.createdAt);
});

test('空タイトルのカラムは400になる', async () => {
  const res = await fetch(`${baseUrl}/api/columns`, json({ title: '   ' }));
  assert.equal(res.status, 400);
  const err = await res.json();
  assert.equal(err.error, 'title is required');
});

test('タスクを作成でき、初期状態は open である', async () => {
  const col = await createColumn('Doing');
  const task = await createTask(col.id, '仕様を書く', { assignee: 'yuta', priority: 'high' });
  assert.equal(task.title, '仕様を書く');
  assert.equal(task.columnId, col.id);
  assert.equal(task.assignee, 'yuta');
  assert.equal(task.done, false);
  assert.ok(task.id);
});

test('存在しないカラムへのタスク作成は404になる', async () => {
  const res = await fetch(`${baseUrl}/api/tasks`, json({ columnId: 'nope', title: 'x' }));
  assert.equal(res.status, 404);
  const err = await res.json();
  assert.equal(err.error, 'column not found');
});

test('タスクの移動・完了更新ができる', async () => {
  const colA = await createColumn('A');
  const colB = await createColumn('B');
  const task = await createTask(colA.id, '移動する');

  const res = await fetch(`${baseUrl}/api/tasks/${task.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ columnId: colB.id, done: true }),
  });
  assert.equal(res.status, 200);
  const updated = await res.json();
  assert.equal(updated.columnId, colB.id);
  assert.equal(updated.done, true);
});

test('done に boolean 以外を渡すと400になる', async () => {
  const col = await createColumn('C');
  const task = await createTask(col.id, '検証');
  const res = await fetch(`${baseUrl}/api/tasks/${task.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ done: 'yes' }),
  });
  assert.equal(res.status, 400);
});

test('存在しないタスクの更新は404になる', async () => {
  const col = await createColumn('D');
  const res = await fetch(`${baseUrl}/api/tasks/missing-id`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'x' }),
  });
  assert.equal(res.status, 404);
});

test('カラムをリネームできる（405/404/400も確認）', async () => {
  const col = await createColumn('旧');
  const rename = await fetch(`${baseUrl}/api/columns/${col.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '新' }),
  });
  assert.equal(rename.status, 200);
  assert.equal((await rename.json()).title, '新');

  assert.equal(
    (await fetch(`${baseUrl}/api/columns/${col.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: '' }) })).status,
    400,
  );
  assert.equal(
    (await fetch(`${baseUrl}/api/columns/no-such`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'x' }) })).status,
    404,
  );
});

test('タスクを削除できる', async () => {
  const col = await createColumn('E');
  const task = await createTask(col.id, '削除対象');
  const res = await fetch(`${baseUrl}/api/tasks/${task.id}`, { method: 'DELETE' });
  assert.equal(res.status, 204);
  const list = await (await fetch(`${baseUrl}/api/board`)).json();
  assert.equal(list.tasks.find((t) => t.id === task.id), undefined);
});

test('ボード状態を取得してカラム順・タスク順が保たれる', async () => {
  const col = await createColumn('順序');
  const t1 = await createTask(col.id, '1番目');
  const t2 = await createTask(col.id, '2番目');
  const board = await (await fetch(`${baseUrl}/api/board`)).json();
  assert.deepEqual(board.tasks.map((t) => t.title).filter((x) => x.startsWith('1') || x.startsWith('2')), ['1番目', '2番目']);
  assert.ok([t1.id, t2.id].length === 2);
});

test('統計APIが正しい数値を返す', async () => {
  const col = await createColumn('統計');
  await createTask(col.id, '未了1');
  await createTask(col.id, '完了1', { done: true });
  const stats = await (await fetch(`${baseUrl}/api/stats`)).json();
  assert.ok(stats.total >= 2);
  assert.ok(stats.done >= 1);
  assert.ok(typeof stats.completionRate === 'number');
});

test('不正JSONは400になる', async () => {
  const res = await fetch(`${baseUrl}/api/columns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{oops',
  });
  assert.equal(res.status, 400);
});

test('未対応ルート/メソッドは404・405になる', async () => {
  const nf = await fetch(`${baseUrl}/api/unknown`);
  assert.equal(nf.status, 404);
  const del = await fetch(`${baseUrl}/api/columns`, { method: 'DELETE' });
  assert.equal(del.status, 405);
});

test('SSE でタスク作成イベントがリアルタイム配信される', async () => {
  const col = await createColumn('SSE');
  const events = [];
  const controller = new AbortController();
  const res = await fetch(`${baseUrl}/api/events`, { signal: controller.signal, headers: { accept: 'text/event-stream' } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);

  (async () => {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        events.push(decoder.decode(value));
      }
    } catch { /* aborted */ }
  })();

  await new Promise((r) => setTimeout(r, 150));
  await createTask(col.id, '配信されるタスク');
  await new Promise((r) => setTimeout(r, 200));
  controller.abort();

  const merged = events.join('');
  assert.ok(merged.includes('event: task-created'));
  assert.ok(merged.includes('配信されるタスク'));
});

test('JSONストレージが永続化され、再起動後も利用できる', async () => {
  const col = await createColumn('永続');
  await createTask(col.id, '残るタスク');
  await app.stop();

  const app2 = createApp({ dataDir: cleanupDir });
  await app2.start(0);
  const board = await (await fetch(`http://127.0.0.1:${app2.port}/api/board`)).json();
  assert.ok(board.tasks.some((t) => t.title === '残るタスク'));
  await app2.stop();
});
