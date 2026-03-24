import { db, schema } from "../db/index.js";
import { eq } from "drizzle-orm";
import { jobQueue, type QueuedJob } from "./queue.js";
import { registry } from "../plugins/registry.js";
import type { DownloadJob, SessionData } from "../plugins/base.js";
import { getSettingValue } from "../api/routes/settings.js";
import { resolveOutputPath, zipAndCleanup, removeOldDownload } from "../storage/index.js";
import { notifyDownloadError, notifyQueueEmpty, resolvePendingReply } from "../discord/notify.js";
import { logger } from "../logger.js";
import path from "path";
import fs from "fs/promises";

const log = logger.child({ module: "Worker" });

const DEFAULT_POLL_INTERVAL = 5000; // 5 seconds

interface RunningJob {
  abortController: AbortController;
  outputDir: string;
  zipPath: string;
}

export class Worker {
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private runningJobs = new Map<number, RunningJob>();

  // Track completed/failed discord-sourced jobs since last queue-empty notification
  private discordCompleted: { title: string; volume: number; unit: string; filePath?: string }[] = [];
  private discordFailed: { title: string; volume: number; unit: string; error: string }[] = [];

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

  /**
   * Cancel a running job: abort the download, clean up partial files, update DB.
   */
  async cancelRunningJob(jobId: number): Promise<boolean> {
    const entry = this.runningJobs.get(jobId);
    if (!entry) return false;

    log.info(`Cancelling running job #${jobId}`);
    entry.abortController.abort();
    // Cleanup and DB update happen in processJob's finally/catch block
    return true;
  }

  private async poll(): Promise<void> {
    if (!this.running) return;

    // Check concurrency limit
    const concurrency = getSettingValue<number>("download.concurrency") ?? 1;
    const hasRunning = await jobQueue.hasRunningJobs();
    if (hasRunning && concurrency <= 1) return;

    const job = await jobQueue.dequeue();
    if (!job) {
      // Queue is empty — send summary notification for discord-sourced jobs
      if (this.discordCompleted.length + this.discordFailed.length > 0) {
        const completed = [...this.discordCompleted];
        const failed = [...this.discordFailed];
        this.discordCompleted = [];
        this.discordFailed = [];
        notifyQueueEmpty({ completed, failed }).catch((e) => log.warn(`Queue-empty notification failed: ${e}`));
      }
      return;
    }

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
    const displayGenres: string[] = libraryData.displayGenres
      ? JSON.parse(libraryData.displayGenres)
      : [];
    const { outputDir, zipPath } = resolveOutputPath({
      plugin: queuedJob.pluginId,
      title: libraryData.title,
      volume: volumeData.volumeNum,
      unit: volumeData.unit ?? "vol",
      author: libraryData.author ?? undefined,
      tags: displayGenres,
    });

    // Remove old download if path has changed (e.g. template was updated)
    if (volumeData.filePath && volumeData.filePath !== zipPath) {
      await removeOldDownload(volumeData.filePath);
    }

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

        const canAutoRelogin = plugin.manifest?.loginMethods?.includes("credentials") ?? false;

        if (sessionValid) {
          session = plugin.auth.getSession();
        } else if (canAutoRelogin) {
          // Re-login only if plugin supports credentials-based login
          log.info(`Session invalid for account #${account.id}, re-logging in...`);
          if (!account.credentials) {
            throw new Error("認証情報が保存されていません。アカウント設定からログインしてください");
          }
          const credentials = JSON.parse(account.credentials);
          const success = await plugin.auth.login(credentials);
          if (!success) {
            throw new Error("ログインに失敗しました。認証情報を確認してください");
          }
          if (account.cookiePath) {
            const fs = await import("fs/promises");
            const path = await import("path");
            await fs.mkdir(path.dirname(account.cookiePath), { recursive: true });
            await plugin.auth.saveSession(account.cookiePath);
            log.info(`Re-login successful for account #${account.id}`);
          }
          session = plugin.auth.getSession();
        } else {
          throw new Error("セッションが無効です。アカウント設定からログインしてください");
        }
      }
    }

    const abortController = new AbortController();
    this.runningJobs.set(queuedJob.id, { abortController, outputDir, zipPath });

    try {
      const generator = plugin.downloader.download(downloadJob, session);

      for await (const progress of generator) {
        // Check if cancelled
        if (abortController.signal.aborted) {
          await generator.return(undefined as any);
          await this.cleanupPartialDownload(outputDir, zipPath);
          await jobQueue.cancel(queuedJob.id);
          log.info(`Job #${queuedJob.id} cancelled`);
          return;
        }

        await jobQueue.updateProgress(queuedJob.id, progress.progress, progress.message);

        if (progress.phase === "error") {
          await jobQueue.fail(queuedJob.id, progress.message, queuedJob.volumeId);
          return;
        }
      }

      // Zip the downloaded pages
      log.info(`Job #${queuedJob.id} zipping to ${zipPath}`);
      await zipAndCleanup(outputDir, zipPath);

      // Generator completed
      await jobQueue.complete(queuedJob.id, queuedJob.volumeId);

      // Update volume file info (point to zip file)
      const stat = await fs.stat(zipPath).catch(() => null);
      db.update(schema.volumes)
        .set({
          filePath: zipPath,
          fileSize: stat?.size ?? null,
          downloadedAt: new Date().toISOString(),
        })
        .where(eq(schema.volumes.id, queuedJob.volumeId!))
        .run();

      log.info(`Job #${queuedJob.id} completed`);

      if (queuedJob.source === "discord") {
        this.discordCompleted.push({
          title: libraryData.title,
          volume: volumeData.volumeNum,
          unit: volumeData.unit ?? "vol",
          filePath: zipPath,
        });
        resolvePendingReply(queuedJob.volumeId!, {
          success: true,
          filePath: zipPath,
          fileSize: stat?.size ?? undefined,
        }).catch((e) => log.warn(`Failed to resolve pending reply: ${e}`));
      }
    } catch (error) {
      if (abortController.signal.aborted) {
        await this.cleanupPartialDownload(outputDir, zipPath);
        await jobQueue.cancel(queuedJob.id);
        log.info(`Job #${queuedJob.id} cancelled`);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      const maxJobRetries = getSettingValue<number>("download.jobRetryCount") ?? 1;

      if (queuedJob.retryCount < maxJobRetries) {
        log.warn(`Job #${queuedJob.id} failed: ${message}, scheduling retry (${queuedJob.retryCount + 1}/${maxJobRetries})`);
        await this.cleanupPartialDownload(outputDir, zipPath);
        await jobQueue.retry(queuedJob.id);
      } else {
        log.error(`Job #${queuedJob.id} failed: ${message} (no retries left)`);
        await jobQueue.fail(queuedJob.id, message, queuedJob.volumeId);

        if (queuedJob.source === "discord") {
          this.discordFailed.push({
            title: libraryData?.title ?? "Unknown",
            volume: volumeData?.volumeNum ?? 0,
            unit: volumeData?.unit ?? "vol",
            error: message,
          });

          if (queuedJob.volumeId) {
            resolvePendingReply(queuedJob.volumeId, {
              success: false,
              error: message,
            }).catch((e) => log.warn(`Failed to resolve pending reply: ${e}`));
          }

          notifyDownloadError({
            title: libraryData?.title ?? "Unknown",
            volume: volumeData?.volumeNum ?? 0,
            unit: volumeData?.unit ?? "vol",
            plugin: queuedJob.pluginId,
            error: message,
          }).catch((e) => log.warn(`Download-error notification failed: ${e}`));
        }
      }
    } finally {
      this.runningJobs.delete(queuedJob.id);
    }
  }

  private async cleanupPartialDownload(outputDir: string, zipPath?: string): Promise<void> {
    try {
      await fs.rm(outputDir, { recursive: true, force: true });
      if (zipPath) {
        await fs.rm(zipPath, { force: true }).catch(() => {});
      }
      log.info(`Cleaned up partial download: ${outputDir}`);
    } catch (err) {
      log.warn(`Failed to clean up ${outputDir}: ${err}`);
    }
  }
}

export const worker = new Worker();
