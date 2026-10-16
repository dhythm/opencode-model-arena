import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { LeaderboardEntry } from "../protocol.ts";

const MAX_ENTRIES = 100;
const FLUSH_DELAY_MS = 250;

export type Leaderboard = {
  load: () => Promise<void>;
  record: (entries: LeaderboardEntry[]) => void;
  top: (limit?: number) => LeaderboardEntry[];
  flush: () => Promise<void>;
};

function isEntry(value: unknown): value is LeaderboardEntry {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.name === "string" &&
    typeof e.wpm === "number" &&
    typeof e.accuracy === "number" &&
    typeof e.textId === "string" &&
    typeof e.at === "number"
  );
}

const sortEntries = (entries: LeaderboardEntry[]): LeaderboardEntry[] =>
  [...entries].sort((a, b) => b.wpm - a.wpm || b.accuracy - a.accuracy).slice(0, MAX_ENTRIES);

export function createLeaderboard(dataDir: string): Leaderboard {
  const file = join(dataDir, "leaderboard.json");
  let entries: LeaderboardEntry[] = [];
  let dirty = false;
  let timer: NodeJS.Timeout | null = null;

  const flush = async (): Promise<void> => {
    if (!dirty) return;
    dirty = false;
    try {
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, JSON.stringify(entries, null, 2), "utf8");
      await rename(tmp, file);
    } catch (err) {
      dirty = true;
      console.error("[leaderboard] persist failed:", (err as Error).message);
    }
  };

  const schedule = (): void => {
    dirty = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, FLUSH_DELAY_MS);
  };

  return {
    async load() {
      try {
        const raw = await readFile(file, "utf8");
        const parsed: unknown = JSON.parse(raw);
        entries = Array.isArray(parsed) ? parsed.filter(isEntry) : [];
        entries = sortEntries(entries);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          console.error("[leaderboard] load failed, starting empty:", (err as Error).message);
        }
        entries = [];
      }
    },
    record(newEntries) {
      if (newEntries.length === 0) return;
      entries = sortEntries([...entries, ...newEntries]);
      schedule();
    },
    top(limit = 10) {
      return entries.slice(0, limit);
    },
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await flush();
    },
  };
}
