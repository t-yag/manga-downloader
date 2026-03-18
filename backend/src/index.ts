import "dotenv/config";
import { logger } from "./logger.js";
import { createApp } from "./api/index.js";
import { worker } from "./queue/worker.js";
import { registry } from "./plugins/registry.js";
import { initDatabase } from "./db/init.js";

// Import plugins
import { createCmoaPlugin } from "./plugins/cmoa/index.js";
import { createBookLivePlugin } from "./plugins/booklive/index.js";
import { createMomongaPlugin } from "./plugins/momonga/index.js";
import { createNhentaiPlugin } from "./plugins/nhentai/index.js";
import { createPiccomaPlugin } from "./plugins/piccoma/index.js";
import { createKindlePlugin } from "./plugins/kindle/index.js";

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";

async function main() {
  logger.info("manga-downloader backend starting...");

  // Initialize database
  initDatabase();

  // Register plugins
  registry.register(createCmoaPlugin());
  registry.register(createBookLivePlugin());
  registry.register(createMomongaPlugin());
  registry.register(createNhentaiPlugin());
  registry.register(createPiccomaPlugin());
  registry.register(createKindlePlugin());
  logger.info(`Registered ${registry.getAll().length} plugin(s)`);

  // Start API server
  const app = await createApp();
  await app.listen({ port: PORT, host: HOST });
  logger.info(`API server listening on ${HOST}:${PORT}`);

  // Start download worker
  worker.start();

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down...");
    worker.stop();
    await registry.disposeAll();
    await app.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  logger.error(error, "Failed to start");
  process.exit(1);
});
