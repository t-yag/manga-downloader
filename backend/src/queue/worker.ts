import { db, schema } from "../db/index.js";
import { eq } from "drizzle-orm";
import { jobQueue, type QueuedJob } from "./queue.js";
import { registry } from "../plugins/registry.js";
import type { DownloadJob, SessionData } from "../plugins/base.js";
import { getSettingValue } from "../api/routes/settings.js";
import { logger } from "../logger.js";
import path from "path";

const log = logger.child({ module: "Worker" });

const DEFAULT_POLL_INTERVAL = 5000; // 5 seconds

export class Worker {
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    if (this.running) return;
    this.running = true;
    log.info("Started");
    this.poll();
    this.timer = setInterval(() => this.poll(), DEFAULT_POLL_INTERVAL);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    log.info("Stopped");
  }

  private async poll(): Promise<void> {
    if (!this.running) return;

    // Check concurrency limit
    const concurrency = getSettingValue<number>("download.concurrency") ?? 1;
    const hasRunning = await jobQueue.hasRunningJobs();
    if (hasRunning && concurrency <= 1) return;

    const job = await jobQueue.dequeue();
    if (!job) return;

    log.info(`Processing job #${job.id} (plugin: ${job.pluginId})`);
    await this.processJob(job);
  }

  private async processJob(queuedJob: QueuedJob): Promise<void> {
    const plugin = registry.get(queuedJob.pluginId);
    if (!plugin) {
      await jobQueue.fail(queuedJob.id, `Plugin "${queuedJob.pluginId}" not found`, queuedJob.volumeId);
      return;
    }

    // Get volume info from DB
    let volumeData: typeof schema.volumes.$inferSelect | undefined;
    let libraryData: typeof schema.library.$inferSelect | undefined;

    if (queuedJob.volumeId) {
      volumeData = db
        .select()
        .from(schema.volumes)
        .where(eq(schema.volumes.id, queuedJob.volumeId))
        .get();

      if (volumeData?.libraryId) {
        libraryData = db
          .select()
          .from(schema.library)
          .where(eq(schema.library.id, volumeData.libraryId))
          .get();
      }
    }

    if (!volumeData || !libraryData) {
      await jobQueue.fail(queuedJob.id, "Volume or library data not found", queuedJob.volumeId);
      return;
    }

    // Build download job
    const volumeMeta = volumeData.metadata ? JSON.parse(volumeData.metadata) : {};
    const basePath = getSettingValue<string>("download.basePath") ?? path.join(process.cwd(), "data", "downloads");
    const titleDir = libraryData.title.replace(/[<>:"\/\\|?*]/g, "_").substring(0, 100);
    const volDir = `vol_${String(volumeData.volumeNum).padStart(3, "0")}`;
    const outputDir = path.join(basePath, queuedJob.pluginId, titleDir, volDir);

    const downloadJob: DownloadJob = {
      jobId: queuedJob.id,
      titleId: libraryData.titleId,
      volume: volumeData.volumeNum,
      readerUrl: volumeMeta.readerUrl ?? "",
      contentKey: volumeMeta.contentKey ?? "",
      outputDir,
    };

    // Get session from account (with auto re-login if invalid)
    let session: SessionData | null = null;
    if (queuedJob.accountId && plugin.auth) {
      const account = db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.id, queuedJob.accountId))
        .get();

      if (account) {
        // Try loading existing session
        let sessionValid = false;
        if (account.cookiePath) {
          const loaded = await plugin.auth.loadSession(account.cookiePath);
          if (loaded) {
            sessionValid = await plugin.auth.validateSession();
          }
        }

        // Re-login if session is missing or invalid
        if (!sessionValid && account.credentials) {
          log.info(`Session invalid for account #${account.id}, re-logging in...`);
          try {
            const credentials = JSON.parse(account.credentials);
            const success = await plugin.auth.login(credentials);
            if (success && account.cookiePath) {
              const fs = await import("fs/promises");
              const path = await import("path");
              await fs.mkdir(path.dirname(account.cookiePath), { recursive: true });
              await plugin.auth.saveSession(account.cookiePath);
              log.info(`Re-login successful for account #${account.id}`);
            }
          } catch (loginError) {
            log.error(loginError, `Re-login failed for account #${account.id}`);
          }
        }

        session = plugin.auth.getSession();
      }
    }

    try {
      const generator = plugin.downloader.download(downloadJob, session);

      let result;
      for await (const progress of generator) {
        await jobQueue.updateProgress(queuedJob.id, progress.progress, progress.message);

        if (progress.phase === "error") {
          await jobQueue.fail(queuedJob.id, progress.message, queuedJob.volumeId);
          return;
        }

        // Check if generator returned a value
        if (progress.phase === "done") {
          // The return value will come after the loop
        }
      }

      // Generator completed - get the return value via the last next() call
      await jobQueue.complete(queuedJob.id, queuedJob.volumeId);

      // Update volume file info
      db.update(schema.volumes)
        .set({
          filePath: outputDir,
          downloadedAt: new Date().toISOString(),
        })
        .where(eq(schema.volumes.id, queuedJob.volumeId!))
        .run();

      log.info(`Job #${queuedJob.id} completed`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`Job #${queuedJob.id} failed: ${message}`);
      await jobQueue.fail(queuedJob.id, message, queuedJob.volumeId);
    }
  }
}

export const worker = new Worker();
