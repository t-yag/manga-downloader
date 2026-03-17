import { db, schema } from "../db/index.js";
import { eq, and, asc, sql, type InferSelectModel } from "drizzle-orm";

type VolumeStatus = NonNullable<InferSelectModel<typeof schema.volumes>["status"]>;

export interface QueuedJob {
  id: number;
  pluginId: string;
  accountId: number | null;
  volumeId: number | null;
  status: string;
  priority: number;
  progress: number;
  retryCount: number;
  message: string | null;
  error: string | null;
}

/**
 * SQLite-based job queue. Simple polling approach.
 * Can be replaced with BullMQ + Redis later if needed.
 */
export class JobQueue {
  /**
   * Add a new job to the queue.
   */
  async enqueue(params: {
    pluginId: string;
    accountId?: number;
    volumeId?: number;
    priority?: number;
  }): Promise<number> {
    // Capture the current volume status before changing it
    let prevVolumeStatus: string | null = null;
    if (params.volumeId) {
      const vol = db
        .select({ status: schema.volumes.status })
        .from(schema.volumes)
        .where(eq(schema.volumes.id, params.volumeId))
        .get();
      prevVolumeStatus = vol?.status ?? null;
    }

    const result = db
      .insert(schema.jobs)
      .values({
        pluginId: params.pluginId,
        accountId: params.accountId ?? null,
        volumeId: params.volumeId ?? null,
        priority: params.priority ?? 0,
        status: "pending",
        progress: 0,
        prevVolumeStatus,
      })
      .returning({ id: schema.jobs.id })
      .get();

    // Update volume status if linked
    if (params.volumeId) {
      db.update(schema.volumes)
        .set({ status: "queued" })
        .where(eq(schema.volumes.id, params.volumeId))
        .run();
    }

    return result.id;
  }

  /**
   * Pick the next pending job (highest priority first, then oldest first).
   */
  async dequeue(): Promise<QueuedJob | null> {
    const job = db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.status, "pending"))
      .orderBy(asc(schema.jobs.priority), asc(schema.jobs.createdAt))
      .limit(1)
      .get();

    if (!job) return null;

    // Mark as running
    db.update(schema.jobs)
      .set({
        status: "running",
        startedAt: new Date().toISOString(),
      })
      .where(eq(schema.jobs.id, job.id))
      .run();

    if (job.volumeId) {
      db.update(schema.volumes)
        .set({ status: "downloading" })
        .where(eq(schema.volumes.id, job.volumeId))
        .run();
    }

    return job as QueuedJob;
  }

  /**
   * Update job progress.
   */
  async updateProgress(jobId: number, progress: number, message?: string): Promise<void> {
    db.update(schema.jobs)
      .set({
        progress,
        message: message ?? null,
      })
      .where(eq(schema.jobs.id, jobId))
      .run();
  }

  /**
   * Mark job as completed.
   */
  async complete(jobId: number, volumeId?: number | null): Promise<void> {
    db.update(schema.jobs)
      .set({
        status: "done",
        progress: 1.0,
        finishedAt: new Date().toISOString(),
      })
      .where(eq(schema.jobs.id, jobId))
      .run();

    if (volumeId) {
      db.update(schema.volumes)
        .set({
          status: "done",
          downloadedAt: new Date().toISOString(),
        })
        .where(eq(schema.volumes.id, volumeId))
        .run();
    }
  }

  /**
   * Mark job as failed.
   */
  async fail(jobId: number, error: string, volumeId?: number | null): Promise<void> {
    db.update(schema.jobs)
      .set({
        status: "error",
        error,
        finishedAt: new Date().toISOString(),
      })
      .where(eq(schema.jobs.id, jobId))
      .run();

    if (volumeId) {
      db.update(schema.volumes)
        .set({ status: "error" })
        .where(eq(schema.volumes.id, volumeId))
        .run();
    }
  }

  /**
   * Cancel a pending or running job.
   */
  async cancel(jobId: number): Promise<boolean> {
    const job = db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.id, jobId))
      .get();

    if (!job || (job.status !== "pending" && job.status !== "running")) {
      return false;
    }

    db.update(schema.jobs)
      .set({
        status: "cancelled",
        finishedAt: new Date().toISOString(),
      })
      .where(eq(schema.jobs.id, jobId))
      .run();

    if (job.volumeId) {
      db.update(schema.volumes)
        .set({ status: (job.prevVolumeStatus ?? "unknown") as VolumeStatus })
        .where(eq(schema.volumes.id, job.volumeId))
        .run();
    }

    return true;
  }

  /**
   * Cancel all pending jobs. Returns the number of cancelled jobs.
   */
  async cancelAllPending(): Promise<number> {
    const pendingJobs = db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.status, "pending"))
      .all();

    db.transaction((tx) => {
      for (const job of pendingJobs) {
        tx.update(schema.jobs)
          .set({
            status: "cancelled",
            finishedAt: new Date().toISOString(),
          })
          .where(eq(schema.jobs.id, job.id))
          .run();

        if (job.volumeId) {
          tx.update(schema.volumes)
            .set({ status: (job.prevVolumeStatus ?? "unknown") as VolumeStatus })
            .where(eq(schema.volumes.id, job.volumeId))
            .run();
        }
      }
    });

    return pendingJobs.length;
  }

  /**
   * Retry a failed job: reset to pending and increment retryCount.
   */
  async retry(jobId: number): Promise<void> {
    db.update(schema.jobs)
      .set({
        status: "pending",
        progress: 0,
        error: null,
        message: null,
        startedAt: null,
        finishedAt: null,
        retryCount: sql`${schema.jobs.retryCount} + 1`,
      })
      .where(eq(schema.jobs.id, jobId))
      .run();

    const job = db
      .select({ volumeId: schema.jobs.volumeId })
      .from(schema.jobs)
      .where(eq(schema.jobs.id, jobId))
      .get();

    if (job?.volumeId) {
      db.update(schema.volumes)
        .set({ status: "queued" })
        .where(eq(schema.volumes.id, job.volumeId))
        .run();
    }
  }

  /**
   * Check if there are any running jobs.
   */
  async hasRunningJobs(): Promise<boolean> {
    const job = db
      .select({ id: schema.jobs.id })
      .from(schema.jobs)
      .where(eq(schema.jobs.status, "running"))
      .limit(1)
      .get();

    return !!job;
  }
}

export const jobQueue = new JobQueue();
