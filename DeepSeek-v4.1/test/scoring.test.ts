import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateProgress,
  computeWpm,
  computeAccuracy,
  elapsedMs,
} from "../src/game/scoring.ts";

test("evaluateProgress: 完全一致は finished かつ progress=1", () => {
  const r = evaluateProgress("hello", "hello");
  assert.equal(r.correctChars, 5);
  assert.equal(r.errors, 0);
  assert.equal(r.progress, 1);
  assert.equal(r.finished, true);
});

test("evaluateProgress: 途中まで正確に入力", () => {
  const r = evaluateProgress("hello world", "hello");
  assert.equal(r.correctChars, 5);
  assert.equal(r.errors, 0);
  assert.equal(r.typedLength, 5);
  assert.equal(r.finished, false);
  assert.ok(Math.abs(r.progress - 5 / 11) < 1e-9);
});

test("evaluateProgress: 誤入力は errors に計上される", () => {
  const r = evaluateProgress("hello", "hxllo");
  assert.equal(r.correctChars, 4);
  assert.equal(r.errors, 1);
  assert.equal(r.finished, true);
});

test("evaluateProgress: 余分に入力しても target 長で評価される", () => {
  const r = evaluateProgress("hi", "hippopotamus");
  assert.equal(r.correctChars, 2);
  assert.equal(r.errors, 10);
  assert.equal(r.progress, 1);
  assert.equal(r.finished, true);
});

test("evaluateProgress: 空入力は progress=0", () => {
  const r = evaluateProgress("hello", "");
  assert.equal(r.correctChars, 0);
  assert.equal(r.errors, 0);
  assert.equal(r.progress, 0);
  assert.equal(r.finished, false);
});

test("computeWpm: 5文字を1分で打つと1WPM", () => {
  assert.equal(computeWpm(5, 60_000), 1);
});

test("computeWpm: 経過時間0は0", () => {
  assert.equal(computeWpm(50, 0), 0);
});

test("computeWpm: 300文字を60秒なら60WPM", () => {
  assert.equal(computeWpm(300, 60_000), 60);
});

test("computeAccuracy: 8/10 は 80%", () => {
  assert.equal(computeAccuracy(8, 10), 80);
});

test("computeAccuracy: 入力0は100%", () => {
  assert.equal(computeAccuracy(0, 0), 100);
});

test("computeAccuracy: 範囲外は 0..100 に丸められる", () => {
  assert.equal(computeAccuracy(20, 10), 100);
});

test("elapsedMs: startedAt が null なら 0", () => {
  assert.equal(elapsedMs(null, 12345), 0);
});

test("elapsedMs: 負にならない", () => {
  assert.equal(elapsedMs(1000, 500), 0);
  assert.equal(elapsedMs(1000, 2500), 1500);
});
