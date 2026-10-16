export type Progress = {
  typedLength: number;
  correctChars: number;
  errors: number;
  progress: number;
  finished: boolean;
};

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * typed が target に対してどれだけ正しいかを評価する。
 * 位置 i の一致を数える（挿入ミスで全体がずれるのを避けるため、
 * 各インデックスを独立に比較する方式を採用）。
 */
export function evaluateProgress(target: string, typed: string): Progress {
  if (target.length === 0) {
    return { typedLength: typed.length, correctChars: 0, errors: typed.length, progress: 1, finished: typed.length > 0 };
  }
  const limit = Math.min(typed.length, target.length);
  let correctChars = 0;
  for (let i = 0; i < limit; i += 1) {
    if (typed[i] === target[i]) correctChars += 1;
  }
  const typedLength = typed.length;
  const errors = typedLength - correctChars;
  const finished = typedLength >= target.length;
  return {
    typedLength,
    correctChars,
    errors,
    progress: clamp01(correctChars / target.length),
    finished,
  };
}

/** 分あたり単語数。5文字=1単語の慣習に従う。 */
export function computeWpm(correctChars: number, elapsedMs: number): number {
  if (elapsedMs <= 0 || correctChars <= 0) return 0;
  const minutes = elapsedMs / 60_000;
  const wpm = correctChars / 5 / minutes;
  return Math.round(wpm * 10) / 10;
}

/** 正答率(%)。入力が無いときは100とする。 */
export function computeAccuracy(correctChars: number, typedChars: number): number {
  if (typedChars <= 0) return 100;
  const ratio = correctChars / typedChars;
  return Math.round(clamp01(ratio) * 1000) / 10;
}

export function elapsedMs(startedAt: number | null, now: number): number {
  if (startedAt === null) return 0;
  return Math.max(0, now - startedAt);
}
