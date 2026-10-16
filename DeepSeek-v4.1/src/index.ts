import { createApp } from "./server/http.ts";

const PORT = Number(process.env.PORT) || 3000;
const app = createApp({ dataDir: process.env.DATA_DIR ?? undefined });

app
  .start(PORT)
  .then((port) => {
    console.log(`\n  DeepSeek TypeRace`);
    console.log(`  ----------------------------------------`);
    console.log(`  http://localhost:${port}\n`);
  })
  .catch((err: unknown) => {
    console.error("サーバー起動に失敗しました:", err);
    process.exit(1);
  });

const shutdown = async (): Promise<void> => {
  console.log("\n停止しています...");
  await app.stop();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
