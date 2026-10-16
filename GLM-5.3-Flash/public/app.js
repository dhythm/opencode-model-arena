/* GLM Board — vanilla JS frontend (no frameworks, no build step) */

const $ = (sel) => document.querySelector(sel);
const boardEl = $('#board');
const statsEl = $('#stats');
const activityList = $('#activityList');
const searchEl = $('#search');
const dialog = $('#taskDialog');
const form = $('#taskForm');

const state = { board: { columns: [], tasks: [] }, filter: '', editingId: null };
let me = localStorage.getItem('glmboard.me') || '';

const PRIORITY_LABEL = { low: '低', medium: '中', high: '高' };
const AVATAR_COLORS = ['#6c8cff', '#22d3a5', '#f59e0b', '#ec4899', '#8b5cf6', '#14b8a6', '#f97316'];
const hashColor = (name) => AVATAR_COLORS[[...name].reduce((h, c) => h * 31 + c.charCodeAt(0), 7) % AVATAR_COLORS.length];

/* ---- API client with error handling ---- */
async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try { message = (await res.json()).error ?? message; } catch { /* no body */ }
    throw new Error(message);
  }
  return res.status === 204 ? null : res.json();
}

/* ---- rendering ---- */
function avatar(name) {
  if (!name) return '';
  return `<span class="avatar" style="background:${hashColor(name)}" title="${escapeHtml(name)}">${escapeHtml(name.slice(0, 1))}</span>`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function taskMatchesSearch(task) {
  if (!state.filter) return true;
  const q = state.filter.toLowerCase();
  return task.title.toLowerCase().includes(q) || (task.assignee ?? '').toLowerCase().includes(q);
}

function renderStats() {
  const { columns, tasks } = state.board;
  const done = tasks.filter((t) => t.done).length;
  const rate = tasks.length ? Math.round((done / tasks.length) * 1000) / 10 : 0;
  statsEl.innerHTML = `
    <div class="stat"><b>${columns.length}</b><span class="muted">カラム</span></div>
    <div class="stat"><b>${tasks.length}</b><span class="muted">タスク</span></div>
    <div class="stat"><b>${done}</b><span class="muted">完了</span></div>
    <div class="stat"><b>${rate}%</b><span class="muted">完了率</span></div>`;
}

function render() {
  const { columns, tasks } = state.board;
  boardEl.innerHTML = '';

  for (const col of columns) {
    const colTasks = tasks
      .filter((t) => t.columnId === col.id && taskMatchesSearch(t))
      .sort((a, b) => a.order - b.order);

    const columnEl = document.createElement('section');
    columnEl.className = 'column';
    columnEl.dataset.columnId = col.id;
    columnEl.innerHTML = `
      <div class="column-head">
        <h2>${escapeHtml(col.title)}</h2>
        <span class="count">${colTasks.length}</span>
        <div class="col-actions">
          <button class="col-btn" data-action="rename" title="カラム名を変更">✏️</button>
          <button class="col-btn" data-action="delete" title="カラムを削除">🗑️</button>
        </div>
      </div>
      <div class="tasks"></div>
      <button class="add-task" data-action="add-task">＋ タスクを追加</button>`;

    const listEl = columnEl.querySelector('.tasks');
    for (const task of colTasks) listEl.appendChild(renderTask(task, col));
    boardEl.appendChild(columnEl);
  }

  const addBtn = document.createElement('button');
  addBtn.className = 'add-column';
  addBtn.textContent = '＋ カラムを追加';
  addBtn.addEventListener('click', addColumn);
  boardEl.appendChild(addBtn);
  renderStats();
}

function renderTask(task, col) {
  const el = document.createElement('article');
  el.className = `task${task.done ? ' done' : ''}`;
  el.dataset.taskId = task.id;
  el.dataset.priority = task.priority;
  el.draggable = true;
  el.innerHTML = `
    <div class="task-title">${escapeHtml(task.title)}</div>
    <div class="task-meta">
      <span class="badge">${PRIORITY_LABEL[task.priority] ?? task.priority}</span>
      ${avatar(task.assignee)}
      <button class="check-toggle" title="完了切替">${task.done ? '↩ 戻す' : '✓ 完了'}</button>
    </div>`;
  el.addEventListener('click', (e) => {
    if (e.target.closest('.check-toggle')) {
      toggleDone(task, col);
      return;
    }
    openDialog(task);
  });
  attachDragHandlers(el, task);
  return el;
}

/* ---- interactions ---- */
async function toggleDone(task, col) {
  try {
    await api(`/api/tasks/${task.id}`, { method: 'PATCH', body: { done: !task.done } });
  } catch (err) {
    toast(`更新に失敗しました: ${err.message}`, true);
  }
}

async function addColumn() {
  const title = prompt('カラム名を入力してください');
  if (!title?.trim()) return;
  try {
    await api('/api/columns', { method: 'POST', body: { title: title.trim() } });
  } catch (err) {
    toast(`作成に失敗しました: ${err.message}`, true);
  }
}

async function renameColumn(colId, currentTitle) {
  const title = prompt('新しいカラム名', currentTitle);
  if (!title?.trim() || title.trim() === currentTitle) return;
  try {
    // カラム内の先頭タスク経由ではなく、専用APIを用意せず簡易実装: 削除→作成は破壊的なため
    // ここでは title 変更 API (/api/columns/:id PATCH) を利用
    await api(`/api/columns/${colId}`, { method: 'PATCH', body: { title: title.trim() } });
  } catch (err) {
    toast(`変更に失敗しました: ${err.message}`, true);
  }
}

async function deleteColumn(colId) {
  if (!confirm('このカラムとタスクをすべて削除しますか？')) return;
  try {
    await api(`/api/columns/${colId}`, { method: 'DELETE' });
  } catch (err) {
    toast(`削除に失敗しました: ${err.message}`, true);
  }
}

async function addTask(columnId) {
  const title = prompt('タスクのタイトルを入力してください');
  if (!title?.trim()) return;
  try {
    await api('/api/tasks', { method: 'POST', body: { columnId, title: title.trim(), assignee: me || undefined } });
  } catch (err) {
    toast(`作成に失敗しました: ${err.message}`, true);
  }
}

/* ---- drag & drop ---- */
let draggingTask = null;

function attachDragHandlers(el, task) {
  el.addEventListener('dragstart', (e) => {
    draggingTask = task;
    el.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', task.id);
  });
  el.addEventListener('dragend', () => {
    draggingTask = null;
    el.classList.remove('dragging');
    document.querySelectorAll('.column.drag-over').forEach((c) => c.classList.remove('drag-over'));
  });
}

boardEl.addEventListener('dragover', (e) => {
  const column = e.target.closest('.column');
  if (!column || !draggingTask) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('.column.drag-over').forEach((c) => c.classList.remove('drag-over'));
  column.classList.add('drag-over');
});

boardEl.addEventListener('drop', async (e) => {
  const column = e.target.closest('.column');
  if (!column || !draggingTask || draggingTask.columnId === column.dataset.columnId) {
    document.querySelectorAll('.column.drag-over').forEach((c) => c.classList.remove('drag-over'));
    return;
  }
  e.preventDefault();
  const targetTasks = state.board.tasks
    .filter((t) => t.columnId === column.dataset.columnId && !t.done === !draggingTask.done)
    .filter((t) => t.id !== draggingTask.id)
    .sort((a, b) => a.order - b.order);
  const order = targetTasks.length;
  try {
    await api(`/api/tasks/${draggingTask.id}`, {
      method: 'PATCH',
      body: { columnId: column.dataset.columnId, order },
    });
  } catch (err) {
    toast(`移動に失敗しました: ${err.message}`, true);
  }
  document.querySelectorAll('.column.drag-over').forEach((c) => c.classList.remove('drag-over'));
});

/* ---- dialog (edit) ---- */
function openDialog(task) {
  state.editingId = task.id;
  $('#fTitle').value = task.title;
  $('#fAssignee').value = task.assignee ?? '';
  $('#fPriority').value = task.priority;
  $('#fDone').checked = task.done;
  const select = $('#fColumn');
  select.innerHTML = state.board.columns
    .map((c) => `<option value="${c.id}"${c.id === task.columnId ? ' selected' : ''}>${escapeHtml(c.title)}</option>`)
    .join('');
  dialog.showModal();
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  e.stopPropagation(); // method="dialog" による自動クローズを抑制
  if (!state.editingId) return;
  try {
    const assignee = $('#fAssignee').value.trim();
    if (assignee && !me) {
      me = assignee;
      localStorage.setItem('glmboard.me', me);
    }
    await api(`/api/tasks/${state.editingId}`, {
      method: 'PATCH',
      body: {
        title: $('#fTitle').value.trim(),
        assignee,
        priority: $('#fPriority').value,
        done: $('#fDone').checked,
        columnId: $('#fColumn').value,
      },
    });
    dialog.close();
  } catch (err) {
    toast(`保存に失敗しました: ${err.message}`, true);
  }
});

$('#cancelBtn').addEventListener('click', () => dialog.close());
$('#deleteBtn').addEventListener('click', async () => {
  if (!state.editingId || !confirm('このタスクを削除しますか？')) return;
  try {
    await api(`/api/tasks/${state.editingId}`, { method: 'DELETE' });
    dialog.close();
  } catch (err) {
    toast(`削除に失敗しました: ${err.message}`, true);
  }
});

/* ---- board-level delegation ---- */
boardEl.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const column = btn.closest('.column');
  const colId = column?.dataset.columnId;
  const action = btn.dataset.action;
  if (action === 'add-task') addTask(colId);
  if (action === 'rename') {
    const col = state.board.columns.find((c) => c.id === colId);
    if (col) renameColumn(colId, col.title);
  }
  if (action === 'delete') deleteColumn(colId);
});

/* ---- activity feed & SSE ---- */
function logActivity(action, color) {
  const li = document.createElement('li');
  const time = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  li.innerHTML = `<span style="color:${color ?? 'var(--muted)'}">${escapeHtml(action)}</span><br><span class="muted">${time}</span>`;
  activityList.prepend(li);
  while (activityList.children.length > 40) activityList.lastChild.remove();
}

const EVENT_LABELS = {
  'task-created': (t) => `📝 「${t.title}」を作成`,
  'task-updated': (t) => `✏️ 「${t.title}」を更新${t.done ? '（完了✓）' : ''}`,
  'task-deleted': (t) => `🗑️ 「${t.title}」を削除`,
  'column-created': (c) => `📂 カラム「${c.title}」を追加`,
  'column-updated': (c) => `📂 カラム「${c.title}」を更新`,
  'column-deleted': (c) => `🗑️ カラム「${c.title}」を削除`,
};

const BOARD_SYNC_EVENTS = new Set([
  'task-created', 'task-updated', 'task-deleted',
  'column-created', 'column-updated', 'column-deleted', 'board-updated',
]);

let syncTimer;
function requestBoardSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncBoard().catch((err) => toast(`ボードの再同期に失敗しました: ${err.message}`, true));
  }, 100);
}

async function syncBoard() {
  state.board = await api('/api/board');
  render();
}

function connectEvents() {
  const es = new EventSource('/api/events');
  es.onopen = () => {
    if (activityList.firstElementChild?.classList.contains('muted')) activityList.innerHTML = '';
    logActivity('🟢 リアルタイム接続を確立');
  };
  for (const [type, format] of Object.entries(EVENT_LABELS)) {
    es.addEventListener(type, (e) => {
      let payload = null;
      try { payload = JSON.parse(e.data); } catch { /* malformed event */ }
      if (payload) logActivity(format(payload));
      if (BOARD_SYNC_EVENTS.has(type)) requestBoardSync();
    });
  }
  es.addEventListener('board-updated', () => requestBoardSync());
  es.onerror = () => logActivity('⏳ 接続が切断されました。再接続中…');
}

/* ---- theme ---- */
const preferred = localStorage.getItem('glmboard.theme');
if (preferred) document.documentElement.dataset.theme = preferred;
$('#themeToggle').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  $('#themeToggle').textContent = next === 'light' ? '☀️' : '🌙';
  localStorage.setItem('glmboard.theme', next);
});

searchEl.addEventListener('input', () => {
  state.filter = searchEl.value.trim();
  render();
});

/* ---- toast ---- */
let toastTimer;
function toast(message, isError = false) {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = `toast${isError ? ' error' : ''}`;
  el.textContent = message;
  document.body.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 3200);
}

/* ---- boot ---- */
async function boot() {
  try {
    state.board = await api('/api/board');
    render();
    connectEvents();
  } catch (err) {
    toast(`サーバーに接続できません: ${err.message}`, true);
    activityList.innerHTML = '<li class="muted">サーバーに接続できません</li>';
  }
}
boot();
