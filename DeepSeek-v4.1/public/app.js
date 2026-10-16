const $ = (id) => document.getElementById(id);

const screens = {
  home: $("home"),
  lobby: $("lobby"),
  race: $("race"),
  result: $("result"),
};

const els = {
  name: $("name"),
  code: $("code"),
  create: $("create"),
  join: $("join"),
  homeError: $("home-error"),
  leaderboard: $("leaderboard"),
  lobbyCode: $("lobby-code"),
  copy: $("copy"),
  leave: $("leave"),
  textPicker: $("text-picker"),
  playerList: $("player-list"),
  playerCount: $("player-count"),
  ready: $("ready"),
  start: $("start"),
  lobbyHint: $("lobby-hint"),
  countdown: $("countdown"),
  countdownNum: $("countdown-num"),
  statWpm: $("stat-wpm"),
  statAcc: $("stat-acc"),
  statTime: $("stat-time"),
  typingView: $("typing-view"),
  typingInput: $("typing-input"),
  lanes: $("lanes"),
  resultList: $("result-list"),
  rematch: $("rematch"),
  resultLeave: $("result-leave"),
  resultHint: $("result-hint"),
  toast: $("toast"),
};

const state = {
  ws: null,
  you: null,
  room: null,
  status: null,
  target: "",
  charSpans: [],
  raceKey: null,
  clockOffset: 0,
  countdownTimer: null,
  elapsedTimer: null,
  toastTimer: null,
};

const DIFFICULTY_LABEL = { easy: "EASY", normal: "NORMAL", hard: "HARD" };

let textsCache = [];

function show(name) {
  for (const [key, node] of Object.entries(screens)) {
    node.classList.toggle("hidden", key !== name);
  }
}

function toast(message, ok = false) {
  els.toast.textContent = message;
  els.toast.classList.remove("hidden");
  els.toast.classList.toggle("ok", ok);
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => els.toast.classList.add("hidden"), 2600);
}

function selfPlayer() {
  if (!state.room || !state.you) return null;
  return state.room.players.find((p) => p.id === state.you.id) ?? null;
}

/* ---------- networking ---------- */

function ensureSocket() {
  if (state.ws && state.ws.readyState <= WebSocket.OPEN) return state.ws;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws = ws;
  ws.addEventListener("message", onServerMessage);
  ws.addEventListener("close", onSocketClose);
  return ws;
}

function connect() {
  const ws = ensureSocket();
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("サーバーに接続できません")), { once: true });
  });
}

const send = (message) => {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(message));
};

function onServerMessage(event) {
  let message;
  try {
    message = JSON.parse(event.data);
  } catch {
    return;
  }
  if (message.type === "error") {
    if (!state.room) els.homeError.textContent = message.message;
    else toast(message.message);
    return;
  }
  if (message.type === "joined") {
    state.you = message.you;
    els.homeError.textContent = "";
    renderRoom(message.room);
    return;
  }
  if (message.type === "room") {
    renderRoom(message.room);
  }
}

function onSocketClose() {
  if (state.room) {
    state.room = null;
    state.you = null;
    state.status = null;
    show("home");
    toast("接続が切れました");
    loadLeaderboard();
  }
}

async function doJoin(code) {
  els.homeError.textContent = "";
  const name = els.name.value.trim();
  if (!name) {
    els.homeError.textContent = "ニックネームを入力してください";
    els.name.focus();
    return;
  }
  try {
    await connect();
  } catch (err) {
    els.homeError.textContent = err.message;
    return;
  }
  send(code ? { type: "join", name, code } : { type: "join", name });
}

/* ---------- room rendering ---------- */

function renderRoom(room) {
  const previous = state.status;
  state.room = room;
  state.status = room.status;
  state.clockOffset = room.serverNow - Date.now();

  if (room.status === "lobby") {
    stopCountdown();
    stopElapsed();
    show("lobby");
    renderLobby(room);
    return;
  }
  if (room.status === "countdown") {
    show("race");
    renderRace(room);
    if (previous !== "countdown") startCountdown(room);
    return;
  }
  if (room.status === "racing") {
    show("race");
    renderRace(room);
    if (previous !== "racing") {
      stopCountdown();
      startElapsed(room);
      els.typingInput.focus();
    }
    return;
  }
  if (room.status === "finished") {
    stopCountdown();
    stopElapsed();
    show("result");
    renderResult(room);
  }
}

/* ---------- lobby ---------- */

function renderLobby(room) {
  const me = selfPlayer();
  els.lobbyCode.textContent = room.code;
  els.playerCount.textContent = String(room.players.length);

  els.textPicker.innerHTML = "";
  for (const text of textsCache) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "text-chip" + (text.id === room.textId ? " active" : "");
    chip.innerHTML = `<span>${escapeHtml(text.title)}</span><span class="difficulty">${DIFFICULTY_LABEL[text.difficulty] ?? ""}</span>`;
    const isHost = me?.isHost ?? false;
    chip.disabled = !isHost;
    chip.addEventListener("click", () => send({ type: "setText", textId: text.id }));
    els.textPicker.appendChild(chip);
  }

  els.playerList.innerHTML = "";
  for (const player of room.players) {
    const li = document.createElement("li");
    const initial = escapeHtml((player.name[0] ?? "?").toUpperCase());
    const tags = [];
    if (player.isHost) tags.push('<span class="tag host">HOST</span>');
    if (player.ready) tags.push('<span class="tag ready">READY</span>');
    li.innerHTML = `<span class="avatar">${initial}</span><span class="pname">${escapeHtml(player.name)}${player.id === state.you?.id ? " (あなた)" : ""}</span>${tags.join("")}`;
    els.playerList.appendChild(li);
  }

  els.ready.textContent = me?.ready ? "準備取消" : "準備OK";
  const isHost = me?.isHost ?? false;
  els.start.classList.toggle("hidden", !isHost);
  els.start.disabled = room.players.length === 0;
  els.lobbyHint.textContent = isHost ? "準備ができたらスタートを押してください" : "ホストの開始を待っています…";
}

/* ---------- race ---------- */

function renderRace(room) {
  const key = `${room.code}:${room.startedAt ?? "cd"}`;
  if (state.raceKey !== key) {
    state.raceKey = key;
    state.typed = "";
    els.typingInput.value = "";
    buildTypingView(room.target);
  }
  updateStats(room);
  renderLanes(room);
}

function buildTypingView(target) {
  state.target = target;
  state.charSpans = [];
  els.typingView.innerHTML = "";
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < target.length; i += 1) {
    const span = document.createElement("span");
    span.className = "ch pending";
    span.textContent = target[i];
    fragment.appendChild(span);
    state.charSpans.push(span);
  }
  els.typingView.appendChild(fragment);
  updateTypingView("");
}

function updateTypingView(typed) {
  const spans = state.charSpans;
  const target = state.target;
  for (let i = 0; i < spans.length; i += 1) {
    const span = spans[i];
    if (i < typed.length) span.className = "ch " + (typed[i] === target[i] ? "correct" : "wrong");
    else if (i === typed.length) span.className = "ch current";
    else span.className = "ch pending";
  }
}

function updateStats(room) {
  const me = selfPlayer();
  els.statWpm.textContent = String(me?.wpm ?? 0);
  els.statAcc.textContent = `${me?.accuracy ?? 100}%`;
}

function renderLanes(room) {
  els.lanes.innerHTML = "";
  for (const player of room.players) {
    const lane = document.createElement("div");
    lane.className = "lane" + (player.finished ? " done" : "") + (player.id === state.you?.id ? " me" : "");
    const pct = Math.round(player.progress * 100);
    lane.innerHTML = `
      <div class="lane-head">
        <span class="lname">${escapeHtml(player.name)}${player.id === state.you?.id ? " (あなた)" : ""}${player.finished ? " 🏁" : ""}</span>
        <span class="lwpm">${player.wpm} WPM</span>
      </div>
      <div class="lane-track"><div class="lane-fill" style="width:${pct}%"></div></div>`;
    els.lanes.appendChild(lane);
  }
}

function startCountdown(room) {
  stopCountdown();
  els.countdown.classList.remove("hidden");
  const offset = room.serverNow - Date.now();
  const tick = () => {
    const remaining = (room.countdownEndsAt ?? 0) - (Date.now() + offset);
    els.countdownNum.textContent = remaining <= 0 ? "GO!" : String(Math.ceil(remaining / 1000));
  };
  tick();
  state.countdownTimer = setInterval(tick, 80);
}

function stopCountdown() {
  clearInterval(state.countdownTimer);
  state.countdownTimer = null;
  els.countdown.classList.add("hidden");
}

function startElapsed(room) {
  stopElapsed();
  const offset = room.serverNow - Date.now();
  const base = room.startedAt ?? Date.now();
  const tick = () => {
    const seconds = Math.max(0, (Date.now() + offset - base) / 1000);
    els.statTime.textContent = `${seconds.toFixed(1)}s`;
  };
  tick();
  state.elapsedTimer = setInterval(tick, 100);
}

function stopElapsed() {
  clearInterval(state.elapsedTimer);
  state.elapsedTimer = null;
}

/* ---------- result ---------- */

const MEDALS = ["🥇", "🥈", "🥉"];

function renderResult(room) {
  const ranked = [...room.players].sort((a, b) => {
    if (a.rank !== null && b.rank !== null) return a.rank - b.rank;
    if (a.rank !== null) return -1;
    if (b.rank !== null) return 1;
    return b.progress - a.progress;
  });

  els.resultList.innerHTML = "";
  ranked.forEach((player, index) => {
    const li = document.createElement("li");
    li.className = player.id === state.you?.id ? "me" : "";
    const medal = player.rank !== null ? MEDALS[player.rank - 1] ?? `${player.rank}` : "—";
    const time = player.finishMs !== null ? `${(player.finishMs / 1000).toFixed(2)}s` : "未完走";
    li.innerHTML = `
      <span class="medal">${medal}</span>
      <span>
        <span class="rname">${escapeHtml(player.name)}${player.id === state.you?.id ? " (あなた)" : ""}</span><br />
        <span class="rsub">${time} ・ ${player.errors} ミス</span>
      </span>
      <span class="rwpm">${player.wpm}</span>
      <span class="racc">${player.accuracy}%</span>`;
    els.resultList.appendChild(li);
    void index;
  });

  const me = selfPlayer();
  const isHost = me?.isHost ?? false;
  els.rematch.classList.toggle("hidden", !isHost);
  els.resultHint.textContent = isHost ? "もう一度でリマッチできます" : "ホストのリマッチを待っています…";
  loadLeaderboard();
}

/* ---------- leaderboard ---------- */

async function loadLeaderboard() {
  try {
    const res = await fetch("/api/leaderboard");
    const entries = await res.json();
    els.leaderboard.innerHTML = "";
    if (!Array.isArray(entries) || entries.length === 0) {
      els.leaderboard.innerHTML = '<li class="empty">まだ記録がありません</li>';
      return;
    }
    entries.forEach((entry, index) => {
      const li = document.createElement("li");
      li.innerHTML = `<span class="rank">${index + 1}</span><span>${escapeHtml(entry.name)}</span><span class="wpm">${entry.wpm} WPM</span><span class="acc">${entry.accuracy}%</span>`;
      els.leaderboard.appendChild(li);
    });
  } catch {
    /* 無視 */
  }
}

async function loadTexts() {
  try {
    const res = await fetch("/api/texts");
    textsCache = await res.json();
  } catch {
    textsCache = [];
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

/* ---------- events ---------- */

els.create.addEventListener("click", () => doJoin(null));
els.join.addEventListener("click", () => doJoin(els.code.value.trim().toUpperCase()));
els.name.addEventListener("input", () => (els.homeError.textContent = ""));
document.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  if (screens.home.classList.contains("hidden")) return;
  if (document.activeElement === els.code && els.code.value.trim()) doJoin(els.code.value.trim().toUpperCase());
  else doJoin(null);
});

els.copy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(state.room?.code ?? "");
    toast("コードをコピーしました", true);
  } catch {
    toast("コピーできませんでした");
  }
});

els.ready.addEventListener("click", () => {
  const me = selfPlayer();
  send({ type: "ready", ready: !(me?.ready ?? false) });
});

els.start.addEventListener("click", () => send({ type: "start" }));
els.rematch.addEventListener("click", () => send({ type: "rematch" }));

const leave = () => {
  if (state.ws) state.ws.close();
  state.room = null;
  state.you = null;
  state.status = null;
  state.raceKey = null;
  stopCountdown();
  stopElapsed();
  show("home");
  loadLeaderboard();
};

els.leave.addEventListener("click", leave);
els.resultLeave.addEventListener("click", leave);

els.typingView.addEventListener("click", () => els.typingInput.focus());
els.typingInput.addEventListener("focus", () => els.typingView.classList.add("focused"));
els.typingInput.addEventListener("blur", () => els.typingView.classList.remove("focused"));
els.typingInput.addEventListener("input", () => {
  const typed = els.typingInput.value;
  updateTypingView(typed);
  send({ type: "progress", typed });
});

show("home");
loadTexts();
loadLeaderboard();
