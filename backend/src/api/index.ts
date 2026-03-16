import Fastify from "fastify";
import cors from "@fastify/cors";
import { logger } from "../logger.js";
import { jobRoutes } from "./routes/jobs.js";
import { libraryRoutes } from "./routes/library.js";
import { accountRoutes } from "./routes/accounts.js";
import { settingsRoutes } from "./routes/settings.js";
import { pluginRoutes } from "./routes/plugins.js";
import { tagRoutes } from "./routes/tags.js";

export async function createApp() {
  const app = Fastify({
    disableRequestLogging: true,
    loggerInstance: logger,
  });

  app.addHook("onResponse", (request, reply, done) => {
    const ms = reply.elapsedTime.toFixed(0);
    app.log.info(`${request.method} ${request.url} ${reply.statusCode} ${ms}ms`);
    done();
  });

  await app.register(cors, {
    origin: true, // Allow all origins (single-user app behind VPN)
    methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
  });

  // Register routes
  await app.register(jobRoutes);
  await app.register(libraryRoutes);
  await app.register(accountRoutes);
  await app.register(settingsRoutes);
  await app.register(pluginRoutes);
  await app.register(tagRoutes);

  // Health check
  app.get("/api/health", async () => ({
    status: "ok",
    timestamp: new Date().toISOString(),
  }));

  return app;
}
