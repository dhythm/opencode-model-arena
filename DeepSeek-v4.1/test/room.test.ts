import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createRoom,
  addPlayer,
  removePlayer,
  findPlayer,
  setReady,
  startCountdown,
  beginRace,
  submitProgress,
  allConnectedFinished,
  finalize,
  resetForRematch,
  ranking,
  serialize,
  type Room,
} from "../src/game/room.ts";
import { resolveText } from "../src/game/texts.ts";

const makeRoom = (): Room => {
  const room = createRoom({ code: "ABCD", hostId: "p1", textId: "spark", now: 1000 });
  addPlayer(room, "p1", "Alice");
  return room;
};

test("addPlayer: プレイヤーが追加される", () => {
  const room = makeRoom();
  addPlayer(room, "p2", "Bob");
  assert.equal(room.players.length, 2);
  assert.equal(findPlayer(room, "p2")?.name, "Bob");
});

test("removePlayer: ホスト離脱で別のプレイヤーに引き継がれる", () => {
  const room = makeRoom();
  addPlayer(room, "p2", "Bob");
  removePlayer(room, "p1");
  assert.equal(room.players.length, 1);
  assert.equal(room.hostId, "p2");
});

test("startCountdown: lobby以外では失敗する", () => {
  const room = makeRoom();
  room.status = "racing";
  assert.equal(startCountdown(room, 2000, 3000), false);
});

test("startCountdown: lobbyなら成功しカウントダウン終了時刻が入る", () => {
  const room = makeRoom();
  assert.equal(startCountdown(room, 2000, 3000), true);
  assert.equal(room.status, "countdown");
  assert.equal(room.countdownEndsAt, 5000);
});

test("beginRace: racingになり進捗がリセットされる", () => {
  const room = makeRoom();
  const p = findPlayer(room, "p1")!;
  p.progress = 0.5;
  p.finished = true;
  beginRace(room, 8000);
  assert.equal(room.status, "racing");
  assert.equal(room.startedAt, 8000);
  assert.equal(p.progress, 0);
  assert.equal(p.finished, false);
});

test("submitProgress: 正しい入力で進捗とWPMが更新される", () => {
  const room = makeRoom();
  beginRace(room, 0);
  const target = resolveText("spark").content;
  const typed = target.slice(0, 10);
  const res = submitProgress(room, "p1", typed, 1000);
  const p = findPlayer(room, "p1")!;
  assert.equal(res.finished, false);
  assert.equal(p.correctChars, 10);
  assert.ok(p.progress > 0 && p.progress < 1);
  assert.ok(p.wpm > 0);
  assert.equal(p.accuracy, 100);
});

test("submitProgress: 全文入力でfinishedになり順位が付く", () => {
  const room = makeRoom();
  addPlayer(room, "p2", "Bob");
  beginRace(room, 0);
  const target = resolveText("spark").content;
  submitProgress(room, "p1", target, 5000);
  assert.equal(findPlayer(room, "p1")?.finished, true);
  assert.equal(allConnectedFinished(room), false);
  submitProgress(room, "p2", target, 6000);
  assert.equal(allConnectedFinished(room), true);
});

test("submitProgress: racing以外では無視される", () => {
  const room = makeRoom();
  const res = submitProgress(room, "p1", "hello", 1000);
  assert.equal(res.finished, false);
  assert.equal(findPlayer(room, "p1")?.correctChars, 0);
});

test("finalize: 完了者が速い順にrankされる", () => {
  const room = makeRoom();
  addPlayer(room, "p2", "Bob");
  beginRace(room, 0);
  const target = resolveText("spark").content;
  submitProgress(room, "p1", target, 8000);
  submitProgress(room, "p2", target, 5000);
  const entries = finalize(room, 9000);
  assert.equal(room.status, "finished");
  assert.equal(findPlayer(room, "p1")?.rank, 2);
  assert.equal(findPlayer(room, "p2")?.rank, 1);
  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.name, "Bob");
  assert.ok(entries.every((e) => e.wpm > 0));
});

test("ranking: finished が先頭、未完了は進捗順", () => {
  const room = makeRoom();
  addPlayer(room, "p2", "Bob");
  beginRace(room, 0);
  const target = resolveText("spark").content;
  submitProgress(room, "p2", target, 3000);
  finalize(room, 4000);
  const order = ranking(room);
  assert.equal(order[0]?.id, "p2");
});

test("resetForRematch: lobbyに戻り進捗が消える", () => {
  const room = makeRoom();
  beginRace(room, 0);
  const target = resolveText("spark").content;
  submitProgress(room, "p1", target, 2000);
  finalize(room, 3000);
  assert.equal(resetForRematch(room, 4000), true);
  assert.equal(room.status, "lobby");
  assert.equal(findPlayer(room, "p1")?.progress, 0);
  assert.equal(findPlayer(room, "p1")?.rank, null);
});

test("serialize: クライアント用ビューを生成する", () => {
  const room = makeRoom();
  const view = serialize(room, 12345);
  assert.equal(view.code, "ABCD");
  assert.equal(view.target, resolveText("spark").content);
  assert.equal(view.serverNow, 12345);
  assert.equal(view.players[0]?.isHost, true);
});

test("setReady: ready状態を更新できる", () => {
  const room = makeRoom();
  setReady(room, "p1", true);
  assert.equal(findPlayer(room, "p1")?.ready, true);
});
