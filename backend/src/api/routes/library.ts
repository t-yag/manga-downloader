import type { FastifyInstance } from "fastify";
import { db, schema } from "../../db/index.js";
import { eq, desc, and, inArray, sql } from "drizzle-orm";
import { registry } from "../../plugins/registry.js";
import { jobQueue } from "../../queue/queue.js";
import { logger } from "../../logger.js";

const log = logger.child({ module: "AvailabilityCheck" });

export async function libraryRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /api/url/parse
   * Parse a URL to determine plugin, titleId, and type.
   * Does NOT add to library - just returns the parsed info + metadata preview.
   */
  app.post("/api/url/parse", async (request, reply) => {
    const { url } = request.body as { url: string };

    if (!url) return reply.status(400).send({ error: "URL is required" });

    try {
      const parsed = registry.parseUrl(url);
      const plugin = registry.get(parsed.pluginId);

      let titleInfo = null;
      if (plugin?.metadata) {
        titleInfo = await plugin.metadata.getTitleInfo(parsed.titleId);
      }

      return {
        parsed,
        titleInfo,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return reply.status(400).send({ error: msg });
    }
  });

  /**
   * GET /api/library
   * List all titles in library.
   */
  app.get("/api/library", async () => {
    const titles = db
      .select()
      .from(schema.library)
      .orderBy(desc(schema.library.updatedAt))
      .all();

    // Attach volume summary for each title
    return titles.map((t) => {
      const vols = db
        .select()
        .from(schema.volumes)
        .where(eq(schema.volumes.libraryId, t.id))
        .all();

      const summary = {
        total: vols.length,
        downloaded: vols.filter((v) => v.status === "done").length,
        available: vols.filter((v) => v.status === "available").length,
        unknown: vols.filter((v) => v.status === "unknown").length,
      };

      return {
        ...t,
        genres: t.genres ? JSON.parse(t.genres) : [],
        volumeSummary: summary,
      };
    });
  });

  /**
   * POST /api/library
   * Add title to library. Accepts a URL which is parsed automatically.
   */
  app.post("/api/library", async (request, reply) => {
    const { url, pluginId, titleId } = request.body as {
      url?: string;
      pluginId?: string;
      titleId?: string;
    };

    let resolvedPluginId: string;
    let resolvedTitleId: string;

    if (url) {
      const parsed = registry.parseUrl(url);
      resolvedPluginId = parsed.pluginId;
      resolvedTitleId = parsed.titleId;
    } else if (pluginId && titleId) {
      resolvedPluginId = pluginId;
      resolvedTitleId = titleId;
    } else {
      return reply.status(400).send({ error: "Either url or (pluginId + titleId) is required" });
    }

    const plugin = registry.get(resolvedPluginId);
    if (!plugin?.metadata) {
      return reply.status(400).send({ error: "Plugin not found or does not support metadata" });
    }

    // Check if already exists
    const existing = db
      .select()
      .from(schema.library)
      .where(
        and(
          eq(schema.library.pluginId, resolvedPluginId),
          eq(schema.library.titleId, resolvedTitleId)
        )
      )
      .get();

    if (existing) {
      return reply.status(409).send({ error: "Title already in library", id: existing.id });
    }

    try {
      const titleInfo = await plugin.metadata.getTitleInfo(resolvedTitleId);

      const result = db
        .insert(schema.library)
        .values({
          pluginId: resolvedPluginId,
          titleId: resolvedTitleId,
          title: titleInfo.seriesTitle,
          author: titleInfo.author,
          genres: JSON.stringify(titleInfo.genres),
          totalVolumes: titleInfo.totalVolumes,
          coverUrl: titleInfo.coverUrl,
        })
        .returning()
        .get();

      // Create volume entries
      for (const vol of titleInfo.volumes) {
        db.insert(schema.volumes)
          .values({
            libraryId: result.id,
            volumeNum: vol.volume,
            status: "unknown",
            thumbnailUrl: vol.thumbnailUrl,
            metadata: JSON.stringify({
              readerUrl: vol.readerUrl,
              contentKey: vol.contentKey,
              detailUrl: vol.detailUrl,
            }),
          })
          .onConflictDoNothing()
          .run();
      }

      return {
        ...result,
        genres: titleInfo.genres,
        volumes: titleInfo.volumes,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return reply.status(500).send({ error: msg });
    }
  });

  /**
   * GET /api/library/:id
   * Get title detail with all volumes and their statuses.
   */
  app.get("/api/library/:id", async (request, reply) => {
    const { id } = request.params as { id: string };

    const title = db
      .select()
      .from(schema.library)
      .where(eq(schema.library.id, Number(id)))
      .get();

    if (!title) return reply.status(404).send({ error: "Title not found" });

    const vols = db
      .select()
      .from(schema.volumes)
      .where(eq(schema.volumes.libraryId, title.id))
      .all();

    return {
      ...title,
      genres: title.genres ? JSON.parse(title.genres) : [],
      volumes: vols.map((v) => ({
        ...v,
        metadata: v.metadata ? JSON.parse(v.metadata) : null,
      })),
    };
  });

  /**
   * POST /api/library/:id/refresh
   * Refresh title metadata (re-fetch total volumes, check for new volumes).
   */
  app.post("/api/library/:id/refresh", async (request, reply) => {
    const { id } = request.params as { id: string };

    const title = db
      .select()
      .from(schema.library)
      .where(eq(schema.library.id, Number(id)))
      .get();

    if (!title) return reply.status(404).send({ error: "Title not found" });

    const plugin = registry.get(title.pluginId);
    if (!plugin?.metadata) {
      return reply.status(400).send({ error: "Plugin does not support metadata" });
    }

    try {
      const titleInfo = await plugin.metadata.getTitleInfo(title.titleId);

      // Update library entry
      db.update(schema.library)
        .set({
          title: titleInfo.seriesTitle,
          author: titleInfo.author,
          totalVolumes: titleInfo.totalVolumes,
          coverUrl: titleInfo.coverUrl,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(schema.library.id, title.id))
        .run();

      // Add any new volume entries
      let newVolumes = 0;
      for (const vol of titleInfo.volumes) {
        const existing = db
          .select()
          .from(schema.volumes)
          .where(
            and(
              eq(schema.volumes.libraryId, title.id),
              eq(schema.volumes.volumeNum, vol.volume)
            )
          )
          .get();

        if (!existing) {
          db.insert(schema.volumes)
            .values({
              libraryId: title.id,
              volumeNum: vol.volume,
              status: "unknown",
              thumbnailUrl: vol.thumbnailUrl,
              metadata: JSON.stringify({
                readerUrl: vol.readerUrl,
                contentKey: vol.contentKey,
                detailUrl: vol.detailUrl,
              }),
            })
            .run();
          newVolumes++;
        } else if (vol.thumbnailUrl && existing.thumbnailUrl !== vol.thumbnailUrl) {
          db.update(schema.volumes)
            .set({ thumbnailUrl: vol.thumbnailUrl })
            .where(eq(schema.volumes.id, existing.id))
            .run();
        }
      }

      return {
        message: "Title refreshed",
        totalVolumes: titleInfo.totalVolumes,
        newVolumes,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return reply.status(500).send({ error: msg });
    }
  });

  /**
   * POST /api/library/:id/check-availability
   * Check download availability for un-downloaded volumes.
   * Requires an accountId for authenticated sites.
   */
  app.post("/api/library/:id/check-availability", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { accountId } = (request.body as { accountId?: number }) ?? {};

    const title = db
      .select()
      .from(schema.library)
      .where(eq(schema.library.id, Number(id)))
      .get();

    if (!title) return reply.status(404).send({ error: "Title not found" });

    const plugin = registry.get(title.pluginId);
    if (!plugin?.availabilityChecker) {
      return reply.status(400).send({ error: "Plugin does not support availability checking" });
    }

    // Get volumes that need checking (skip already downloaded or confirmed available)
    const vols = db
      .select()
      .from(schema.volumes)
      .where(eq(schema.volumes.libraryId, title.id))
      .all()
      .filter((v) => v.status !== "done" && v.status !== "available");

    if (vols.length === 0) {
      return { message: "No volumes need checking", results: [] };
    }

    // Get session if accountId provided (with auto re-login if invalid)
    log.info(`titleId=${title.titleId}, accountId=${accountId ?? "none"}, volumes=${vols.map(v => v.volumeNum).join(",")}`);
    let session = null;
    if (accountId && plugin.auth) {
      const account = db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.id, accountId))
        .get();

      if (account) {
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
            log.error(loginError, "Re-login failed");
          }
        }

        session = plugin.auth.getSession();
        log.info(`Session: ${session ? `${session.cookies.length} cookies` : "null"}`);
      }
    } else {
      log.info("No accountId or no auth provider - checking without session");
    }

    try {
      const volumeNums = vols.map((v) => v.volumeNum);
      const results = await plugin.availabilityChecker.checkAvailability(
        title.titleId,
        volumeNums,
        session
      );

      // Update volume statuses in DB
      const now = new Date().toISOString();
      for (const result of results) {
        const vol = vols.find((v) => v.volumeNum === result.volume);
        if (!vol) continue;

        // Don't overwrite queued/downloading statuses
        if (vol.status === "queued" || vol.status === "downloading") continue;

        db.update(schema.volumes)
          .set({
            status: result.available ? "available" : "unavailable",
            availabilityReason: result.reason,
            checkedAt: now,
          })
          .where(eq(schema.volumes.id, vol.id))
          .run();
      }

      return { message: "Availability checked", results };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return reply.status(500).send({ error: msg });
    }
  });

  /**
   * POST /api/library/:id/sync
   * Refresh title metadata, then check availability for unknown volumes (if account exists).
   * If `volumes` is provided, skip refresh and force-check only those specific volumes.
   */
  app.post("/api/library/:id/sync", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { accountId, volumes: targetVolumeNums } = (request.body as { accountId?: number; volumes?: number[] }) ?? {};

    const title = db
      .select()
      .from(schema.library)
      .where(eq(schema.library.id, Number(id)))
      .get();

    if (!title) return reply.status(404).send({ error: "Title not found" });

    const plugin = registry.get(title.pluginId);

    // Helper: resolve session for availability checking
    async function resolveSession() {
      if (!accountId || !plugin?.auth) return null;
      const account = db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.id, accountId))
        .get();
      if (!account) return null;

      let sessionValid = false;
      if (account.cookiePath) {
        const loaded = await plugin.auth.loadSession(account.cookiePath);
        if (loaded) sessionValid = await plugin.auth.validateSession();
      }
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
          }
        } catch (loginError) {
          log.error(loginError, "Re-login failed");
        }
      }
      return plugin.auth.getSession();
    }

    // Helper: check availability for given volumes and update DB
    async function checkAndUpdate(vols: { id: number; volumeNum: number; status: string | null }[]) {
      if (vols.length === 0 || !plugin?.availabilityChecker) return [];
      const session = await resolveSession();
      const results = await plugin.availabilityChecker.checkAvailability(
        title!.titleId,
        vols.map((v) => v.volumeNum),
        session
      );
      const now = new Date().toISOString();
      for (const result of results) {
        const vol = vols.find((v) => v.volumeNum === result.volume);
        if (!vol || vol.status === "queued" || vol.status === "downloading") continue;
        const update: Record<string, unknown> = {
          availabilityReason: result.reason,
          checkedAt: now,
        };
        if (vol.status !== "done") {
          update.status = result.available ? "available" : "unavailable";
        }
        db.update(schema.volumes)
          .set(update)
          .where(eq(schema.volumes.id, vol.id))
          .run();
      }
      return results;
    }

    // --- Mode A: Targeted sync (specific volumes, skip refresh) ---
    if (targetVolumeNums && targetVolumeNums.length > 0) {
      const vols = db
        .select()
        .from(schema.volumes)
        .where(eq(schema.volumes.libraryId, title.id))
        .all()
        .filter((v) => targetVolumeNums.includes(v.volumeNum) && v.status !== "queued" && v.status !== "downloading");

      let availabilityResults: { volume: number; available: boolean; reason: string }[] = [];
      try {
        availabilityResults = await checkAndUpdate(vols);
      } catch (error) {
        log.error(error, "Targeted availability check failed");
      }

      return {
        message: "Sync complete",
        newVolumes: 0,
        totalVolumes: null,
        checkedVolumes: vols.length,
        availableCount: availabilityResults.filter((r) => r.available).length,
      };
    }

    // --- Mode B: Full sync (refresh + check unknown) ---
    if (!plugin?.metadata) {
      return reply.status(400).send({ error: "Plugin does not support metadata" });
    }

    const titleInfo = await plugin.metadata.getTitleInfo(title.titleId);

    db.update(schema.library)
      .set({
        title: titleInfo.seriesTitle,
        author: titleInfo.author,
        totalVolumes: titleInfo.totalVolumes,
        coverUrl: titleInfo.coverUrl,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.library.id, title.id))
      .run();

    let newVolumes = 0;
    for (const vol of titleInfo.volumes) {
      const existing = db
        .select()
        .from(schema.volumes)
        .where(
          and(
            eq(schema.volumes.libraryId, title.id),
            eq(schema.volumes.volumeNum, vol.volume)
          )
        )
        .get();

      if (!existing) {
        db.insert(schema.volumes)
          .values({
            libraryId: title.id,
            volumeNum: vol.volume,
            status: "unknown",
            thumbnailUrl: vol.thumbnailUrl,
            metadata: JSON.stringify({
              readerUrl: vol.readerUrl,
              contentKey: vol.contentKey,
              detailUrl: vol.detailUrl,
            }),
          })
          .run();
        newVolumes++;
      } else if (vol.thumbnailUrl && existing.thumbnailUrl !== vol.thumbnailUrl) {
        db.update(schema.volumes)
          .set({ thumbnailUrl: vol.thumbnailUrl })
          .where(eq(schema.volumes.id, existing.id))
          .run();
      }
    }

    // Check availability for unknown volumes only
    let availabilityResults: { volume: number; available: boolean; reason: string }[] = [];
    const unknownVols = db
      .select()
      .from(schema.volumes)
      .where(eq(schema.volumes.libraryId, title.id))
      .all()
      .filter((v) => v.status === "unknown");

    try {
      availabilityResults = await checkAndUpdate(unknownVols);
    } catch (error) {
      log.error(error, "Availability check failed during sync");
    }

    const availableCount = availabilityResults.filter((r) => r.available).length;

    return {
      message: "Sync complete",
      newVolumes,
      totalVolumes: titleInfo.totalVolumes,
      checkedVolumes: unknownVols.length,
      availableCount,
    };
  });

  /**
   * POST /api/library/:id/download
   * Queue download jobs for selected volumes.
   */
  app.post("/api/library/:id/download", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { volumes: volumeNums, accountId } = request.body as {
      volumes: number[] | "available" | "all";
      accountId?: number;
    };

    const title = db
      .select()
      .from(schema.library)
      .where(eq(schema.library.id, Number(id)))
      .get();

    if (!title) return reply.status(404).send({ error: "Title not found" });

    const plugin = registry.get(title.pluginId);
    if (!plugin) return reply.status(400).send({ error: "Plugin not found" });

    // Get all volumes for this title
    const allVols = db
      .select()
      .from(schema.volumes)
      .where(eq(schema.volumes.libraryId, title.id))
      .all();

    // Determine which volumes to download
    let targetVols: typeof allVols;
    if (volumeNums === "available") {
      targetVols = allVols.filter((v) => v.status === "available");
    } else if (volumeNums === "all") {
      targetVols = allVols.filter((v) => v.status !== "done" && v.status !== "queued" && v.status !== "downloading");
    } else {
      targetVols = allVols.filter((v) => volumeNums.includes(v.volumeNum));
    }

    // Filter out already downloaded/in-progress
    targetVols = targetVols.filter(
      (v) => v.status !== "done" && v.status !== "queued" && v.status !== "downloading"
    );

    if (targetVols.length === 0) {
      return reply.status(400).send({ error: "No volumes eligible for download" });
    }

    // Queue jobs
    const jobIds: number[] = [];
    for (const vol of targetVols) {
      const jobId = await jobQueue.enqueue({
        pluginId: title.pluginId,
        accountId,
        volumeId: vol.id,
      });
      jobIds.push(jobId);
    }

    return {
      message: `${jobIds.length} job(s) queued`,
      jobIds,
      volumes: targetVols.map((v) => v.volumeNum),
    };
  });

  /**
   * PATCH /api/library/:id
   * Update title metadata (e.g. title, author).
   */
  app.patch("/api/library/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { title, author } = request.body as { title?: string; author?: string };

    const existing = db
      .select()
      .from(schema.library)
      .where(eq(schema.library.id, Number(id)))
      .get();

    if (!existing) return reply.status(404).send({ error: "Title not found" });

    const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (title !== undefined) updates.title = title;
    if (author !== undefined) updates.author = author;

    db.update(schema.library)
      .set(updates)
      .where(eq(schema.library.id, Number(id)))
      .run();

    return { message: "Title updated" };
  });

  /**
   * DELETE /api/library/:id
   * Remove title from library (volumes cascade-deleted).
   */
  app.delete("/api/library/:id", async (request, reply) => {
    const { id } = request.params as { id: string };

    const title = db
      .select()
      .from(schema.library)
      .where(eq(schema.library.id, Number(id)))
      .get();

    if (!title) return reply.status(404).send({ error: "Title not found" });

    // Nullify volumeId references in jobs before deleting volumes (FK constraint)
    const vols = db
      .select({ id: schema.volumes.id })
      .from(schema.volumes)
      .where(eq(schema.volumes.libraryId, title.id))
      .all();

    if (vols.length > 0) {
      for (const vol of vols) {
        db.update(schema.jobs)
          .set({ volumeId: null })
          .where(eq(schema.jobs.volumeId, vol.id))
          .run();
      }
    }

    db.delete(schema.library)
      .where(eq(schema.library.id, title.id))
      .run();

    return { message: "Title deleted" };
  });

  /**
   * POST /api/library/:id/delete-volumes
   * Delete downloaded files for selected volumes and reset their status.
   */
  app.post("/api/library/:id/delete-volumes", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { volumes: volumeNums } = request.body as { volumes: number[] };

    if (!volumeNums || volumeNums.length === 0) {
      return reply.status(400).send({ error: "No volumes specified" });
    }

    const title = db
      .select()
      .from(schema.library)
      .where(eq(schema.library.id, Number(id)))
      .get();

    if (!title) return reply.status(404).send({ error: "Title not found" });

    const allVols = db
      .select()
      .from(schema.volumes)
      .where(eq(schema.volumes.libraryId, title.id))
      .all();

    const matched = allVols.filter((v) => volumeNums.includes(v.volumeNum));
    log.info(`delete-volumes: requested=${volumeNums.join(",")}, matched=${matched.length}, statuses=${matched.map(v => `${v.volumeNum}:${v.status}`).join(",")}`);

    const vols = matched.filter((v) => v.status === "done" && v.filePath);

    if (vols.length === 0) {
      return reply.status(400).send({ error: "No downloaded volumes to delete" });
    }

    const fs = await import("fs/promises");
    let deletedCount = 0;
    const errors: string[] = [];

    for (const vol of vols) {
      try {
        await fs.rm(vol.filePath!, { recursive: true });
      } catch (err: any) {
        if (err.code !== "ENOENT") {
          log.warn(`delete-volumes: failed to delete file for vol ${vol.volumeNum}: ${err.message}`);
          errors.push(`Vol ${vol.volumeNum}: ${err.message}`);
          continue;
        }
      }

      db.run(sql`UPDATE volumes SET status = 'unknown', file_path = NULL, file_size = NULL, page_count = NULL, downloaded_at = NULL WHERE id = ${vol.id}`);
      log.info(`delete-volumes: reset vol ${vol.volumeNum} (id=${vol.id})`);

      deletedCount++;
    }

    return {
      message: `${deletedCount}巻のファイルを削除しました`,
      deletedCount,
      errors,
    };
  });
}
