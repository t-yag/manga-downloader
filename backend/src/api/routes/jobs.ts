import type { FastifyInstance } from "fastify";
import { db, schema } from "../../db/index.js";
import { eq, desc } from "drizzle-orm";
import { jobQueue } from "../../queue/queue.js";
import { worker } from "../../queue/worker.js";
import { registry } from "../../plugins/registry.js";

export async function jobRoutes(app: FastifyInstance): Promise<void> {
  // List jobs (enriched with title/volume info)
  app.get("/api/jobs", async (request, reply) => {
    const { status, pluginId, limit = 50, offset = 0 } = request.query as Record<string, string>;

    const jobs = db
      .select()
      .from(schema.jobs)
      .orderBy(desc(schema.jobs.createdAt))
      .limit(Number(limit))
      .offset(Number(offset))
      .all();

    // Filter in JS for simplicity (SQLite is fast enough for this scale)
    const filtered = jobs.filter((j) => {
      if (status && j.status !== status) return false;
      if (pluginId && j.pluginId !== pluginId) return false;
      return true;
    });

    // Enrich with title/volume info
    return filtered.map((j) => {
      let titleName: string | null = null;
      let volumeNum: number | null = null;
      let unit: string | null = null;
      let libraryId: number | null = null;

      if (j.volumeId) {
        const vol = db
          .select()
          .from(schema.volumes)
          .where(eq(schema.volumes.id, j.volumeId))
          .get();
        if (vol) {
          volumeNum = vol.volumeNum;
          unit = vol.unit ?? "vol";
          libraryId = vol.libraryId;
          if (vol.libraryId) {
            const lib = db
              .select({ title: schema.library.title })
              .from(schema.library)
              .where(eq(schema.library.id, vol.libraryId))
              .get();
            if (lib) titleName = lib.title;
          }
        }
      }

      return { ...j, titleName, volumeNum, unit, libraryId };
    });
  });

  // Get job detail
  app.get("/api/jobs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.id, Number(id)))
      .get();

    if (!job) return reply.status(404).send({ error: "Job not found" });
    return job;
  });

  // Create new download job
  app.post("/api/jobs", async (request, reply) => {
    const body = request.body as {
      pluginId: string;
      titleId: string;
      volumes: number[];
      accountId?: number;
    };

    const { pluginId, titleId, volumes, accountId } = body;

    const plugin = registry.get(pluginId);
    if (!plugin) {
      return reply.status(400).send({ error: `Plugin "${pluginId}" not found` });
    }

    // Ensure title exists in library (fetch metadata if not)
    let libraryEntry = db
      .select()
      .from(schema.library)
      .where(eq(schema.library.pluginId, pluginId))
      .all()
      .find((l) => l.titleId === titleId);

    if (!libraryEntry && plugin.metadata) {
      try {
        const titleInfo = await plugin.metadata.getTitleInfo(titleId);
        const result = db
          .insert(schema.library)
          .values({
            pluginId,
            titleId,
            title: titleInfo.title,
            author: titleInfo.author,
            genres: JSON.stringify(titleInfo.genres),
            totalVolumes: titleInfo.totalVolumes,
            coverUrl: titleInfo.coverUrl,
          })
          .returning()
          .get();
        libraryEntry = result;

        // Create volume entries
        for (const vol of titleInfo.volumes) {
          db.insert(schema.volumes)
            .values({
              libraryId: result.id,
              volumeNum: vol.volume,
              unit: vol.unit ?? "vol",
              thumbnailUrl: vol.thumbnailUrl,
              metadata: JSON.stringify({
                readerUrl: vol.readerUrl,
                contentKey: vol.contentKey,
              }),
            })
            .onConflictDoNothing()
            .run();
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return reply.status(500).send({ error: `Failed to fetch title info: ${msg}` });
      }
    }

    if (!libraryEntry) {
      return reply.status(400).send({ error: "Title not found and metadata unavailable" });
    }

    // Create jobs for each volume
    const jobIds: number[] = [];
    for (const volNum of volumes) {
      // Get or create volume entry
      let volumeEntry = db
        .select()
        .from(schema.volumes)
        .where(eq(schema.volumes.libraryId, libraryEntry.id))
        .all()
        .find((v) => v.volumeNum === volNum);

      if (!volumeEntry) {
        volumeEntry = db
          .insert(schema.volumes)
          .values({
            libraryId: libraryEntry.id,
            volumeNum: volNum,
          })
          .returning()
          .get();
      }

      const jobId = await jobQueue.enqueue({
        pluginId,
        accountId,
        volumeId: volumeEntry.id,
      });
      jobIds.push(jobId);
    }

    return { jobIds, message: `${jobIds.length} job(s) queued` };
  });

  // Cancel all pending & running jobs
  app.delete("/api/jobs", async (request, reply) => {
    // Abort all running jobs first
    let runningCancelled = 0;
    const runningJobs = db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.status, "running"))
      .all();

    for (const job of runningJobs) {
      const aborted = await worker.cancelRunningJob(job.id);
      if (aborted) runningCancelled++;
    }

    // Cancel all pending jobs
    const pendingCancelled = await jobQueue.cancelAllPending();

    return {
      message: `Cancelled ${pendingCancelled} pending and ${runningCancelled} running job(s)`,
      pendingCancelled,
      runningCancelled,
    };
  });

  // Cancel job (pending or running)
  app.delete("/api/jobs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const jobId = Number(id);

    // If running, signal worker to abort first
    const aborted = await worker.cancelRunningJob(jobId);
    if (aborted) {
      // Worker handles DB update and file cleanup asynchronously
      return { message: "Job cancellation requested" };
    }

    // Otherwise try cancelling a pending job
    const cancelled = await jobQueue.cancel(jobId);
    if (!cancelled) {
      return reply.status(400).send({ error: "Job cannot be cancelled (may already be finished)" });
    }

    return { message: "Job cancelled" };
  });
}
