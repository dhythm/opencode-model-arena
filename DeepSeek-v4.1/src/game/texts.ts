export type RaceText = {
  id: string;
  title: string;
  difficulty: "easy" | "normal" | "hard";
  content: string;
};

export const TEXTS: readonly RaceText[] = [
  {
    id: "spark",
    title: "火花",
    difficulty: "easy",
    content:
      "The quick brown fox jumps over the lazy dog while the calm river carries a small paper boat past the old stone bridge at dawn.",
  },
  {
    id: "orbit",
    title: "軌道",
    difficulty: "normal",
    content:
      "A good programmer writes code that a stranger can read, because the only thing more expensive than writing software is understanding it a week later under pressure.",
  },
  {
    id: "circuit",
    title: "回路",
    difficulty: "normal",
    content:
      "Simplicity is not the absence of features. It is the deliberate removal of everything that does not serve the goal, leaving a surface so clear that the next person wonders why it took so long.",
  },
  {
    id: "nebula",
    title: "星雲",
    difficulty: "hard",
    content:
      "The telescope whispered secrets of ancient light: galaxies colliding quietly across ten billion years, their dust settling into the exact heaviness that makes a planet breathe and a mind wonder.",
  },
  {
    id: "kernel",
    title: "核心",
    difficulty: "hard",
    content:
      "Optimism without measurement is guesswork; pessimism without measurement is fear. The engineer's discipline is to hold both, build a small instrument, and let the numbers, however surprising, decide.",
  },
] as const;

export const pickRandomTextId = (exclude?: string): string => {
  const pool = exclude ? TEXTS.filter((t) => t.id !== exclude) : TEXTS;
  const list = pool.length > 0 ? pool : TEXTS;
  const index = Math.floor(Math.random() * list.length);
  return list[index]!.id;
};

export const getText = (id: string): RaceText | undefined =>
  TEXTS.find((t) => t.id === id);

export const resolveText = (id: string): RaceText => getText(id) ?? TEXTS[0]!;
